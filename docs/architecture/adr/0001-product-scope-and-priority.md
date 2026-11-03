# ADR-0001: Product scope, priority and boundary

- Status: Accepted, 2026-10-29, owner; decision 5 narrowed to the extracted modules by
  [ADR-0012](0012-foundation-before-qayaba-migration.md) on 2026-10-30
- Decision source: the owner's messages of 2026-10-29 (translated):
  - "isolate this in a separate agnostic library, usable in qayaba for the E2E approach but also for a harness such as
    MCP or another form that fits better"
  - "not tied to the E2E logic only, but with the approach of a 'code truth engine'"
  - "the project's first goal is to serve qayaba and then to serve any agent / harness agnostically, so the decisions
    must not exclude either of these two scenarios"
  - "the idea would be not to split the architecture into components 'for qayaba' and 'generic', but that the same
    ones serve both cases optimally"
  - "the implementation would be done outside this repository, in its own"
  - "the idea is to consider this after the migration, so that it has the benefits being applied"
- Related: [RFC-0001](../rfc/0001-architecture-and-layers.md), [RFC-0009](../rfc/0009-extraction-from-qayaba.md),
  [ADR-0010](0010-trust-modes.md)

**In short:** ye-ast is a separate repository that turns qayaba's deterministic code analysis into an agnostic code
truth engine. It serves qayaba first and any agent or harness second, with the same components in both; scenarios
differ only by deployment profile. It is built after qayaba's ongoing root-cause migration.

## Context

qayaba computes many deterministic facts about the code it tests: code-graph impact walks, module resolution with
dynamic loads, route tables, consumer expectations, front-to-back and back-to-back service links, OpenAPI operation
diffs, co-change. They live inside an E2E engine, yet most of them help any agent that reads or changes code. qayaba
is installed on a company's dedicated server with access to the company's own repositories; a developer's agent runs
on a laptop against the repository it edits.

## Decision

1. **Scope.** ye-ast derives facts from code, git history and declared contracts (OpenAPI, manifests, configuration).
   It may ingest reports produced elsewhere (for example lcov coverage) as inputs. Running or observing an application
   (driving a browser against an environment, capturing DOM, V8 dumps, mutation runs) is not ye-ast: it stays in
   qayaba's own domain.
2. **Priority.** qayaba is the first consumer; any agent or harness is the second. A design that serves one scenario
   and excludes the other is rejected.
3. **One product.** There is no qayaba variant. Differences between scenarios are configuration of a deployment
   profile:

   | Profile axis | qayaba server | Developer machine |
   |---|---|---|
   | Trust mode | `untrusted` | `trusted` |
   | Snapshot | a commit (sha) per run | the live working tree, uncommitted changes included |
   | Process identity | as the host decides ([ADR-0006](0006-qayaba-graph-state-per-run.md)) | the user |
   | Who asks | the host (qayaba's orchestrator) on behalf of its agents | the agent, through MCP or hooks |

   The trust mode describes the repository content ye-ast reads, not the machine it runs on
   ([ADR-0010](0010-trust-modes.md)); the table gives each scenario's usual value.

4. **Separate repository.** ye-ast is developed in its own repository; qayaba consumes it as a dependency.
5. **Timing.** Implementation starts after qayaba's root-cause migration, extracting the modules in their migrated
   form ([RFC-0009](../rfc/0009-extraction-from-qayaba.md)).

## Consequences

- E2E vocabulary (use-case candidates, scenario archetypes, route availability against an environment, Playwright
  harness facts) never enters ye-ast types. A page generalizes to an `Entrypoint` with a kind.
- qayaba keeps adapters from ye-ast facts into its own engine ports and never lets ye-ast types into its domain.
- No LLM runs inside ye-ast. qayaba's LLM steps (the onboarding profile proposer, the context-map run) stay in qayaba
  or are replaced by deterministic facts ([RFC-0004](../rfc/0004-deterministic-map.md)).

## Not decided here

- Publication and licensing ([RFC-0008](../rfc/0008-distribution.md), open question).
- The v1 language scope ([RFC-0007](../rfc/0007-extension-model.md), open question).
