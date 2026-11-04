# Cut analysis: integrated behavior and remaining work

The implemented changes improve module coverage and reference-proof correctness. The symbol-proof work has not
demonstrated a net reduction of cuts on the pinned acceptance corpus. Passing implementation tests does not establish
that the remaining cut families are resolved.

## Implemented units

| Unit | Behavior |
|---|---|
| Module and resource coverage | Read literal runtime loads and type queries, distinguish module traversal from symbol impact, and fingerprint explicit JSON resource inputs. |
| Exact reference identity | Match full occurrences and unique source/target joins; retain ambiguity and respect admitted walk expansion before settlement. |
| Shared member evidence | Reuse one source contract for fixed fields, supported constant locals and inline injection. Unsupported receiver identity remains uncertain. |
| Corrective integration, `ab21740` | Refuse exclusive member identity for constructor value returns; restore certified potential local callers without granting cut-settlement authority. |

The corrective acceptance checks compare complete symbols, entrypoints and seed provenance. They recover the missing
potential dependency paths while retaining all baseline cuts. The selected inline-injection acceptance case remains
unresolved under the current project-wide gates.

## Demonstrated next units

1. **Removed-declaration evidence:** callback call lines can be mistaken for removed declarations. Require
   syntax-backed declaration identity at the existing adapter/application boundary; keep parsers out of domain policy.
   Preserve genuine removed functions, methods and language-specific declarations.
2. **Instantiated injection tokens:** supported erased generic expressions can become opaque before import resolution.
   Normalize the admitted public AST form and retain binding, shadowing and dynamic-expression refusals.
3. **Overbroad member gates:** unrelated provider tokens, record mutations and same-named members can block existing
   capabilities. Narrow them only with evidence about the relevant token, receiver and inheritance path. Removing a
   global refusal without replacement proof is not a correction.

Factory/signal result identity, captured lexical bindings, awaited results, inheritance-aware spelling, external type
provider inputs and selected environment inputs remain separate capabilities or input contracts. Diagnosed refusal
does not establish a removable cut. Semantic coverage of the population remains partial.

## Acceptance for further changes

- Freeze source revisions, configuration, scope and engine identity. Follow the original occurrences separately from
  newly reported uncertainty; do not equate cut records with candidate places.
- Reproduce one real failure and its exact producing predicate before changing behavior.
- Require a real-case improvement and a negative case that retains uncertainty before extending a solution.
- Compare full dependency reach and entrypoint seed provenance. Unexplained lost reach blocks acceptance.
- Keep source evidence in adapters, graph joins in application and cut decisions in domain; reuse the existing
  resolvers, occurrence contract and parsed summaries.

Raw corpus sources, probe outputs and audit ledgers remain local under the intentionally ignored `docs/explainer/`
directory. They are not part of the published repository. The original baseline for the corrective unit is `4f084f8`;
proof version 4 invalidates the resulting derived facts. Reverify any integration with later changes independently.
