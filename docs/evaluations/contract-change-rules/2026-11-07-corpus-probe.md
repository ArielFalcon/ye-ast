# Classified contract differences: corpus probe (2026-11-07)

Before and after RFC-0022 P6 (classified differences), on every revision pair that changed a declared OpenAPI document
in the corpus. The question: of the operations whose contract data a change altered, how many does the consequences
derivation report something for, and with which rule?

## Method

- Corpus: the contract documents with history among the test workspaces, 93 consecutive revision pairs in total:
  `petclinic/backend-rest` (`src/main/resources/openapi.yml`, 35 pairs) and three services of the second corpus
  (`src/main/resources/openapi/api-definition.yaml`: orders 6, restaurants 39, users 13 pairs).
- For each pair, the document at both commits went through `changedContracts` (the digest comparison `impact` reports:
  added, removed, or altered with the parts that differ) and through `planChange` with the OpenAPI shape reader,
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

| Altered part | Count | Reports nothing |
|---|---|---|
| response | 303 | 2 |
| request | 105 | 0 (each an `unclassified-difference` frontier) |

The 2 left are refactors that keep every value set, keyword and digest: an inline schema moved behind a `$ref`, and a
schema split into an `allOf`. Only the textual digest of `impact` differs.

Differences by rule over the 93 pairs:

| Rule | Level | Count |
|---|---|---|
| `response-property-type-changed` | breaking | 11 |
| `response-property-undeclared` | breaking | 227 |
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

Frontiers: `unclassified-difference` 105 at a request and 32 at a schema extension (`x-field-extra-annotation`, which
the corpus generator turns into `@JsonInclude(NON_NULL)` or a validator); `unknown-shape` 134 and `unsupported-delta`
13, as P4 already reported them.

## What the probe changed in the design

- Extensions were first read as documentation. The corpus showed generator extensions that change what the wire
  carries, so an extension is kept as a keyword and a change to it is an `unclassified-difference`.
- `readOnly` was first unclassified (40 frontiers). It restricts what a writer sends, never what a reader receives, so
  it is an annotation for a response.
- A property an open object stops declaring admits every value, and was listed once per class it introduced: 911
  `type-changed` differences. It is one `undeclared` difference now (227), and `type-changed` is left with the 11
  real ones.

## Not measured

Shapes read from Spring handlers (the probe ran the OpenAPI reader only), consumer verdicts (the probe
reads the derivation only), and request classification (P5's server shapes, not built).
