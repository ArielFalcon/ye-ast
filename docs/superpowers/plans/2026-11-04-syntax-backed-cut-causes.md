# Syntax-backed cut causes implementation plan

**Goal:** Reduce uncertainty caused by lost syntax information without suppressing real dependency paths.

**Architecture:** Language adapters supply source evidence through consumer-owned ports. Application reconciles that evidence with selected changes; domain continues to decide seeds and cuts. Keep the existing graph, module resolver and exact occurrence contracts.

**Constraints:** No dependencies, target-code execution, name blacklists or blanket removal of safety gates. Missing sources, unsupported languages and malformed syntax retain existing uncertainty. This increment does not promise population-wide semantic completeness.

## Unit 1: Validate removed-declaration candidates

- [x] Reproduce a callback call mistaken for a removed declaration through the public query boundary.
- [x] Add an optional source-evidence reader at the impact application boundary, wired by composition for TypeScript/JavaScript.
- [x] Validate only names already proposed by the diff. Read the complete changed file in base/head; reject a candidate only when syntactic evidence establishes that no corresponding declaration disappeared. A same-named declaration in another owner must not conceal a real deletion. Unsupported or ambiguous cases keep the candidate.
- [x] Parse only files with candidate names, at most once per version. Reuse existing syntax utilities where applicable; do not construct a project-wide compiler program.
- [x] Exercise real deletions, overloads/signature edits, renamed/moved declarations, homonyms in distinct owners, multiline syntax, missing/malformed sources, deleted files, optional-reader compatibility and cancellation.
- [x] Compare the frozen application response, complete dependency reach and seed provenance. Every removed cut must be attributable to disproven declaration evidence.

The safety requirement in this unit applies to candidates that reach the evidence reader. The existing diff reader may already suppress a removed name when an added declaration elsewhere in the file shares it. Recovering that lost population is a separate corrective unit, not a reason to postpone validation. Record and characterize that limitation; do not change diff candidate generation in this unit.

## Unit 2: Preserve valid instantiated DI token identity

- [x] Reproduce a valid generic token expression becoming opaque in the public Angular reader.
- [x] Normalize only the admitted public TypeScript AST wrapper to the existing token-reference representation. Reuse import resolution, binding/shadowing and substitution checks.
- [x] Check imported aliases and namespace references, constructor decorators and field/inline uses where supported; keep dynamic calls, local shadows and unresolved tokens unknown.
- [x] Verify that relation uncertainty disappears because the token is understood, without granting additional exclusive member-settlement authority.

## Integration and acceptance

- [x] Independently review the actual changes for false exclusion, source completeness, complexity and architectural boundaries.
- [x] Update the existing producer policy identity once for the integrated behavior.
- [x] Run focused tests, typecheck, architecture check and the full test suite.
- [x] Measure the same pinned request before/after, including cuts, candidate places, full symbols, entrypoint seeds, elapsed time and memory. Keep new uncertainty distinct from retired baseline uncertainty.

Project-wide mutation/provider gates are a subsequent unit. First trace which exact predicate would be narrowed, what receiver/token identity supports narrowing, and which mutation/inheritance/provider counterexamples it must preserve. An unknown runtime target cannot be settled solely from its static type.

## Guard investigation outcome

There are independent project-wide blockers: unresolved substitutions, unsupported providers, computed/reflection mutations, and unsafe member spellings. Narrowing only one does not establish a usable member proof while another remains active. A declaration represented as a token is not proof of runtime disjointness: `const TOKEN = Store` aliases the class.

The smallest defensible mutation extension is a fresh local record whose binding has a complete non-escaping use census. Aliasing, return, capture, argument passing, unsupported reads, shadow ambiguity or dynamic binding must retain the refusal. Computed key/value expressions must still be inspected for their own effects. This is a subsequent capability with its own acceptance evidence, not a reason to relax current gates during the syntax units. It does not alone promise a reduction on the pinned application.

## Implementation outcome

The declaration adapter validates the existing candidate names using kind and named-owner counts from the two complete file texts. Explicit object/array binding patterns are traversed to their bound identifiers, including aliases, rest and nesting. Computed declaration names, malformed sources, duplicated owners and unsupported scope identities retain candidates. Syntax diagnostics use the same public isolated `transpileModule` approach already present in import origins; it creates a temporary single-file compiler program internally, without loading or type-checking a project.

Instantiated DI token syntax is normalized only when producing injection relations. Field origins, constructor parameter-property origins, constant-local receiver origins and inline member evidence retain their earlier admissible syntax. Review found that sharing the normalized target with these paths accidentally widened member authority; three public-reader regressions failed before the lead correction and passed afterward. The correction keeps the normalized relation separate instead of introducing new evidence flags or weakening runtime guards.

Native composition has a real Git/graph regression: removing a callback call must not invent a deleted declaration, while an actual deleted function retains its unresolved callers. Existing optional-reader consumers keep the previous behavior. Producer policy version 5 invalidates derived facts.

Final acceptance on frozen source revisions: cuts 300 → 292; candidate places 1,803 → 1,655. Exactly four disproven declaration anchors and four understood injection-relation gaps retire; no cuts are added or modified. All impact values remain identical: 1,514 symbols, 41 entrypoints, 761 seeds, module impact and expansion cost. The selected callers query remains unchanged. Input and snapshot identities match; producer identity changes as intended.

`npm run check` passes typecheck, architecture rules and all 1,859 tests. The final focused adapter/composition run passes 89 tests. The independent review found the member-authority widening described above; its three new negatives fail before and pass after the lead correction. Explicit destructuring support also has an observed failing regression before its correction.

Two alternating branch-query samples per engine give 5.587 s median before and 5.652 s after. The observed difference is 65 ms on this corpus; the sample is too small to guarantee general latency. Process-family maximum RSS reported by shell `time -l` is retained in the private measurement artifact, not treated as a retained-memory or general scalability benchmark.

Raw source evidence, per-occurrence comparisons, logs and probes stay in the intentionally ignored audit directory. These results validate the two syntax units; they do not establish that most remaining receiver cuts are solvable by the same mechanism. Scope-aware mutation/provider proofs and the pre-validation diff candidate loss remain separate work.
