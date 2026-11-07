# Classified contract differences: corpus probe (2026-11-07)

Before and after RFC-0022 P6 (classified differences), on every revision pair that changed a declared OpenAPI document
in the corpus. The question: of the operations whose contract data a change altered, how many does the consequences
derivation report something for, and with which rule?

## Method

- Corpus: the contract documents with history among the test workspaces, 93 consecutive revision pairs in total:
  `petclinic/backend-rest` (`src/main/resources/openapi.yml`, 35 pairs) and three services of the second corpus
  (`src/main/resources/openapi/api-definition.yaml`: orders 6, restaurants 39, users 13 pairs).
- For each pair, the document at both commits went through `changedContracts` (the digest comparison `impact` reports:
  added, removed, or altered with the parts that differ) and through `planChange` with the OpenAPI shape reader (its
  responses and, from the request step on, its requests),
  serving every operation as the document writes it, with the base path set aside so both name an operation alike.
- An altered part is *reported* when the plan holds a hypothesis, a classified difference or a frontier for that
  operation and part. A script outside the repository did this through the library; nothing was written to the corpus.

## Before (main `2ebc1a91`)

| Altered part | Count | Derives nothing |
|---|---|---|
| response | 303 | 195 |
| request | 105 | 105 (no request is derived) |

The 195: 117 changed only keywords a value set does not state (`pattern`, `minLength`, `format`, extensions), 39 added
a property, 38 changed only non-success responses, 1 changed a media type or status.

## After (branch `feat/contract-change-rules`)

| Altered part | Count | Reports nothing | Before the request step |
|---|---|---|---|
| response | 303 | 2 | 2 |
| request | 105 | 0 | 0 (each an `unclassified-difference` frontier) |

The 2 left are refactors that keep every value set, keyword and digest: an inline schema moved behind a `$ref`, and a
schema split into an `allOf`. Only the textual digest of `impact` differs. On the request side, the one
`unclassified-difference` left is the same refactor (a request schema renamed behind its `$ref`).

Differences by rule over the 93 pairs (response side; the request step added 12 `undeclared` and 1 `type-changed`
listed at an array element or the body root, which were only an `unsupported-delta` frontier before):

| Rule | Level | Count |
|---|---|---|
| `response-property-type-changed` | breaking | 12 |
| `response-property-undeclared` | breaking | 239 |
| `response-property-became-nullable` | breaking | 4 |
| `response-property-became-optional` | breaking | 10 |
| `operation-removed` | breaking | 47 |
| `response-property-enum-value-added` | review | 40 |
| `response-property-constraint-widened` | review | 29 |
| `response-property-constraint-changed` | review | 21 |
| `response-error-changed` | review | 44 |
| `response-success-envelope-changed` | review | 2 |
| `response-optional-property-added` | compatible | 105 |
| `response-required-property-added` | compatible | 29 |
| `response-property-became-required` | compatible | 72 |
| `response-property-constraint-narrowed` | compatible | 48 |
| `response-property-annotation-changed` | compatible | 42 |
| `response-property-type-narrowed` | compatible | 4 |
| `response-property-enum-value-removed` | compatible | 3 |
| `operation-added` | compatible | 53 |

Request differences by rule, 276 in total:

| Rule | Level | Count |
|---|---|---|
| `request-property-became-required` | breaking | 20 |
| `request-property-constraint-narrowed` | breaking | 18 |
| `request-required-property-added` | breaking | 16 |
| `request-required-parameter-added` | breaking | 5 |
| `request-property-type-narrowed` | breaking | 4 |
| `request-parameter-enum-value-removed` | breaking | 1 |
| `request-property-enum-value-removed` | breaking | 1 |
| `request-property-removed` | breaking | 1 |
| `request-parameter-removed` | review | 9 |
| `request-property-constraint-changed` | review | 9 |
| `request-property-annotation-changed` | review | 7 |
| `request-property-undeclared` | compatible | 63 |
| `request-optional-property-added` | compatible | 46 |
| `request-optional-parameter-added` | compatible | 18 |
| `request-property-type-widened` | compatible | 15 |
| `request-property-constraint-widened` | compatible | 11 |
| `request-property-enum-value-added` | compatible | 9 |
| `request-property-became-nullable` | compatible | 8 |
| `request-parameter-constraint-widened` | compatible | 8 |
| `request-parameter-enum-value-added` | compatible | 4 |
| `request-property-became-optional` | compatible | 3 |

80 request hypotheses were derived, each naming the rules it answers: 41 from breaking differences and 39 from an
optional property an open base object newly declares (the head rejects the values the base accepted there).

Frontiers before the request step: `unclassified-difference` 105 at a request and 32 at a schema extension (`x-field-extra-annotation`, which
the corpus generator turns into `@JsonInclude(NON_NULL)` or a validator); `unknown-shape` 134 and `unsupported-delta`
13, as P4 already reported them. After it, on the request side: `unknown-shape` 19, `unsupported-delta` 7 (a body
that became required, or a rejection the request vocabulary cannot state), `unclassified-difference` 8 at a request
schema keyword (6 extensions, 2 `id`) and 1 at a request the comparison finds equal.

## Structurally equal refactors

The three altered parts left above were read again, schema by schema. None is a schema renamed behind its `$ref`, and
in each the base and head shapes are equal, so no difference is the right answer:

| Pair | Operation, part | Refactor |
|---|---|---|
| petclinic `83fede1b..2db3bcb1` | `GET /vets`, response | `Vet` split into an `allOf` of `VetFields` and its `id` |
| restaurants `7e646d66..4f697b4b` | `POST /restaurants`, request | `CreateRestaurantRequest` became an `allOf` of `RestaurantData` (its former body) and an empty object |
| restaurants `9fb6441f..d96ccaca` | `GET /restaurants`, response | the inline `metadata` object moved behind `$ref: Metadata` |

The shape reader follows every reference and merges every open `allOf`, so the derivation already compares through
them. The request was the exception: its digest held the schemas the request shapes compare, and a refactor they found
equal still raised the `unclassified-difference` frontier. The request digest now leaves those schemas out, as the
success envelope does: before and after, on the 93 pairs, the only output that changed is that frontier, now gone.

What the `impact` family reports is unchanged: its digest follows the document as written, so the two responses are
still `altered` there. With every reference replaced by its target, 1 of its 408 altered parts would read as equal.

Across the pairs, 9 references of a schema point at another schema at the head; 1 keeps the structure, and 8 change it
and are classified as any change is. 16 places moved between an inline schema and a reference; 5 keep the structure.
None of the 44 `response-error-changed` differences is a rename alone (36 change a schema, 8 a status code).

## What the probe changed in the design

- Extensions were first read as documentation. The corpus showed generator extensions that change what the wire
  carries, so an extension is kept as a keyword and a change to it is an `unclassified-difference`.
- `readOnly` was first unclassified (40 frontiers). It restricts what a writer sends, never what a reader receives, so
  it is an annotation for a response.
- A property an open object stops declaring admits every value, and was listed once per class it introduced: 911
  `type-changed` differences. It is one `undeclared` difference now (227), and `type-changed` is left with the 11
  real ones.

## Not measured

Shapes read from Spring handlers (the probe ran the OpenAPI reader only), and consumer or producer verdicts (the probe
reads the derivation only). One petclinic change run through the CLI turned its 4 request frontiers into 4
`request-property-became-required` differences whose hypotheses the producer evaluator answered (`unknown`,
`no-call-site`, with the api repository bound alone).
