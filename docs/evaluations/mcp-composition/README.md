# MCP composition evaluation

This evaluation compares `ye_ast_compose` with the seven original tools over the same queries and snapshots
(plan `docs/superpowers/plans/2026-11-05-transversal-mcp-evidence-composition.md`, §§10.1–10.3, T7). It measures
structural cost and checks whether a consumer can answer from the evidence with valid citations. It does not prove that
composition is optimal in general, and it does not count tokens.

## Files

| Path | Content |
|---|---|
| `cases.json` | Closed corpus: 8 cases, their queries (by family) and their propositions (required, forbidden with a category, uncertainty) |
| `../../../scripts/evaluate-mcp-composition.ts` | `--prepare` and `--score` |
| `runs/<run-id>/` | Prepared runs and, once collected, responses, judgments and score reports |

## Prepare

```bash
node --import tsx scripts/evaluate-mcp-composition.ts --prepare <out-dir>
```

It creates the real fixture of `src/composition/mcp-evidence-fixture.ts`: two temporary Git repositories, `shop` and
`web`, each with a base and a head commit, plus isolated index, cache, scratch and trust directories. It then runs each case:

- **Baseline:** every original tool in summary, details and full over one in-memory MCP session.
- **Composed:** `ye_ast_compose` with the same queries in every mode, over the same session. If the tool is not
  registered, the evaluator falls back to the coordinator and renderer directly. The manifest then records
  `consumerReady: false`, because that path is not the MCP transport.
- **Order variants:** the composition request again in original, reversed and repository-interleaved order. The run keeps
  only digests, and stores a variant in full only when its output differs.
- **Cold run:** one composition over fresh ports and directories, in a new session.

The fixture is disposed afterwards. Measurements are taken on the raw responses. Stored artifacts replace the fixture
root with `<fixture-root>` and the home directory with `<home>`.

Output:

| File | Content |
|---|---|
| `manifest.json` | Acquisition steps, SHAs, case status, schedule and `expectedResponses`. `synthesis` stays `not_evaluated` |
| `inputs/<case>.json` | Exact queries and orders |
| `outputs/<case>/baseline/q<N>.<mode>.json`, `outputs/<case>/composed/<mode>.json` | `{text, structured, isError}` per call |
| `measurements.json` | See below |
| `prompts/<case>.<condition>.<order>.md` | Consumer prompts |
| `answer-key.json` | Proposition kinds, categories, admissible citation tables or families, and applicability. **Never shown to the consumer** |

`measurements.json` records:

- catalogue and instruction bytes, including the bytes `ye_ast_compose` adds;
- request, text and structured bytes per call and in total;
- wall time per call, labelled warm (shared session) or cold (new ports and directories);
- order invariance and the number of source executions;
- the process peak RSS, labelled as including fixture creation;
- tokens as `not-measured`.

Wall time and memory depend on the machine and on caches; they are not a format saving.

## Consumer protocol

The prompts are prepared for a consumer, but the evaluator calls no model. The operator chooses an authorized consumer.
The script never selects a provider, client or credential.

1. Follow `manifest.json.schedule` in order. Conditions alternate per order and replicate, which counterbalances them.
   Send each prompt in a fresh consumer context, so it never sees the other condition, the answer key or another prompt.
2. The consumer replies `{"answer", "claims", "uncertainties"}`. The operator wraps the reply into one line of
   `responses.jsonl`, adding the scheduled key and the model actually used:
   `{"caseId","condition","order","replicate","model","answer","claims":[{"id","text","citations":[]}],"uncertainties":[...]}`.
   Keep the raw reply verbatim; do not repair citations.
3. A human or a model adjudicates every asserted claim and uncertainty against the cited support, then judges the prose
   answer. Record the results in `judgments.json`:

```json
{"adjudicator":{"kind":"human|model","id":"<who or which model>"},
 "judgments":[
  {"caseId":"…","condition":"…","order":"…","replicate":1,"claimId":"p1","verdict":"supported|unsupported","reason":"…","supports":["<citation the response made>"],"categories":["reach-as-breakage"]},
  {"caseId":"…","condition":"…","order":"…","replicate":1,"claimId":"answer","verdict":"consistent|violates","reason":"…","supports":[],"categories":["unknown-as-empty"]}]}
```

`categories` is optional on a claim judgment and required on a `violates` answer judgment. Its values are:

- `fabricated-causal-link`
- `reach-as-breakage`
- `import-as-call`
- `unknown-as-empty`
- `cross-snapshot`
- `invented-decision-option`

Citations take one of two forms:

- **Baseline:** `q<N>:<RFC 6901 pointer>` into the structured channel of query N. N is the case's query index, not its
  position in the prompt.
- **Composed:** a full wire id from the `graph` tables of the full result. The prefixes are s1, v1, r1, f1, a1, e1, p1,
  n1, l1 and c1.

## Score

```bash
node --import tsx scripts/evaluate-mcp-composition.ts --score <run-dir> --responses <responses.jsonl> --judgments <judgments.json>
```

The report shows one result per expected response, plus counts per case and condition. There is no aggregate quality
score.

**fail**:

- A malformed or duplicate response.
- An unknown catalogue id.
- A claim without citations.
- A citation that does not resolve in the prepared artifacts of its own condition.
- A citation from a table or family that the proposition does not admit.
- Asserting an applicable forbidden proposition. This fails with its category, even when a judgment calls it
  supported.
- A claim judged unsupported, with any categories the adjudicator gives.
- A prose answer judged `violates`, with its categories.

**not_evaluated**:

- A missing response.
- A missing judgment.
- A judgment that is rejected because its `supports` are not resolvable citations made by the response itself.
- An empty or absent responses or judgments file.

**pass**: no failure, every assertion and the answer adjudicated.

Missing required propositions and missing uncertainties are reported as recall. They are not turned into a pass or a
failure.

The scorer never reads prose to decide whether a claim is true. Claim ids come from the corpus, and meaning comes from
recorded adjudications.

## Limits

- The corpus is written against the current fixture data. Re-check every proposition against `outputs/` whenever the
  fixture changes.
- `applicableWhen` uses coarse counters from the composed result (unknown findings or partial/unknown reads). A
  forbidden proposition that does not apply goes to adjudication; it does not fail automatically.
- Prompts use `full` in both conditions, because citations need structured ids or pointers. The readability of
  `summary` and `details` is measured in bytes but not evaluated by a consumer.
- The incompatibility case changes the SHA (base outline against head callers). Live `stateId` divergence is not part
  of this corpus.
- Replicates detect basic variation. They are not a statistical test of generalization.


## Completed implementation and bounded consumer pilot

See [implementation-report.md](implementation-report.md) for current contracts, observed checks, measured costs and limitations. `runs/2026-11-05-semantic-final` has the current collection-state contract. Earlier runs remain diagnostic evidence, not fixtures of the final schema. Consumer pilots do not cover the complete scheduled corpus.

A proposition must cite at least one permitted foundational evidence kind; additional resolving context is allowed and requires semantic adjudication. Every nonexistent citation still fails. If a consumer repeats an assertion ID, identify its judgments by its exact JSON Pointer (for example `/claims/3` or `/uncertainties/0`) instead of changing the raw reply or overwriting a claim. Missing adjudications remain not_evaluated.
