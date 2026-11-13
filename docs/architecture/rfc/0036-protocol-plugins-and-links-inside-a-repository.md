# RFC-0036: A transport is a protocol plugin, and a link inside a repository is kept

- Status: Draft, 2026-11-13
- Related: RFC-0007 ("Plugin kinds": the protocol kind this RFC builds), RFC-0011, RFC-0013, ADR-0013, ADR-0051,
  ADR-0053, ADR-0054, ADR-0058, ADR-0060, ADR-0061, ADR-0065, RFC-0035, RFC-0037, ADR-0076 (the decision this RFC
  designs)

**In short:** RFC-0007 names three plugin kinds, and the protocol kind was never built: the topology knows two
transports as a closed union and branches on them in 33 places. A third way for services to talk (a schema-first HTTP
client, gRPC, GraphQL) has nowhere to enter. Separately, a call a repository makes to its own route is classified
internal and then appears in no answer, so a repository that holds two services, or a client and its server, shows no
relation between them. This RFC makes a transport a plugin, keeps internal links as links, and lets a trace continue
through a decided link.

## Problem

| Fact | Evidence |
|---|---|
| `transport` is a closed union of two values | `src/core/domain/topology/call-site.ts:22`, `src/core/domain/topology/link.ts:24` |
| The event grammars are a closed union of five | `src/core/domain/entrypoints/entrypoint.ts:8`, `src/core/domain/topology/call-site.ts:89` |
| The core branches on the transport's value in 33 places of 15 files | `rg 'transport === "(http|event)"\|transport: "(http|event)"' src/core` |
| The join picks the matcher by comparing with a literal | `src/core/application/topology/workspace-join.ts:40` |
| A call whose links all land in its own repository answers `internal`, and the links are dropped | `src/core/application/topology/workspace-join.ts:47-49`; pinned by `workspace-impact.test.ts:406` |
| A trace returns the links of its requests and stops there | ADR-0061; the walk does not enter the producer's handler |
| In the agent evaluation of 2026-11-08, the cross-stack class was the least served: 8% of its needs | the run is kept outside the repository |

The link correctness itself is good: the last evaluation of four workspaces, kept outside the repository, found 30 of
30, 19 of 19, 152 of 154 and 16 of 16 links correct. The gap is in what can become a link at all, and in what a link
is used for.

## Part A: the protocol plugin

### Contract

```ts
interface ProtocolPlugin {
  id: string;                                  // registered, as languages and frameworks are (RFC-0035)
  /** The matcher of the join: one call site against the entrypoints of the workspace. */
  match(site: CallSite, entrypoints: readonly Entrypoint[], context: JoinContext): JoinResult;
  /** What an unmatched call site could reach, for the cut's reach (ADR-0042). */
  reachOf(site: CallSite): CallSiteReach;
  /** How two contract shapes of this protocol compare, for contract consequences (RFC-0022). Optional. */
  contract?: ContractComparison;
}
```

### Who owns what

| Fact | Owner |
|---|---|
| That a body issues a request or declares a handler, and the text it states | the framework plugin (RFC-0035), which tags it with a protocol `id` |
| The grammar of a target, the ladder of matches, the rating of a match, the class of an unmatched site | the protocol plugin |
| The fixpoint over links (upstream, downstream, the chain) | the topology use case, which reads `id` and never a literal |

### What moves, unchanged

- HTTP: the ladder of RFC-0011 with its amendments (ADR-0054, ADR-0058, ADR-0060, ADR-0065).
- Events: the five grammars become data of one event plugin, as RFC-0007 says of pattern-based protocols.

The move is a refactor. The corpus gate expects no difference, in the `workspace` family included.

### What may enter afterwards

A schema-first protocol (operations listed by an OpenAPI document, a proto file, an SDL) enters as a plugin under
ADR-0013: a parser, fixtures that fail first, measured applications. Its set of operations is deterministic because
the schema lists them (RFC-0007). This RFC adds none.

## Part B: a link inside a repository is a link

### Rule

A link relates a call site to an entrypoint. Whether its two ends share a repository does not decide that it exists.

| Element | Rule |
|---|---|
| Classification | unchanged: a link whose ends share a repository is `internal`, never drift, never `external` |
| Listing | `workspace` lists internal links in their own section, apart from links across repositories |
| Use | workspace impact follows an internal link as it follows any link: a changed route reaches its call sites in the same repository |
| Trace | an effect whose request matches a route of the same repository returns the link, as ADR-0061 does across repositories |
| Modules | each end states the module that owns it where the repository declares modules, so a reader tells a service calling another from a service calling itself |

### First, verify

Before any change, one probe on a fixture of one repository holding a client and its server: what `workspace`,
`impact`, `trace` and `contract-consequences` answer today for that relation. The test at
`workspace-impact.test.ts:406` pins that it is not a cross-repository link. No test found states that some family
reports it. If one does, Part B shrinks to the families that do not.

## Part C: a trace continues through a decided link

| Element | Rule |
|---|---|
| When | a trace run with a workspace meets an effect whose link names exactly one entrypoint |
| What | the handler of that entrypoint is a step below the effect, `via: "link"`, with the repository it belongs to |
| When not | a link that could match several entrypoints, an undecided base, an unmatched site: the effect and its links are returned as today |
| Snapshot | the step is read at the revision the workspace pins for that repository; the fact lists every snapshot it read |
| Budget | the existing depth and expansion budgets; nothing new |

The agent gets one answer from a button to a table, instead of running a second trace from the handler and joining
the two itself.

## Not decided here

| Topic | Why | Where |
|---|---|---|
| Whether a literal host that nothing declares may carry a link at the exact rung | `link-match.test.ts:55` pins that the rung rates path equality without asserting host ownership. ADR-0060 attributes an origin from the links under it, so a wrong link would evidence itself. The frequency on real workspaces is not measured, and literal local hosts carry most real links | measure first, as a ledger row (RFC-0031): links whose origin is literal and declared by nothing |
| `--workspace` on the `impact` and `callers` commands | the usage text gives it to `trace` and `init` only (`src/cli/main.ts:69-74`); ADR-0032 asks every surface to expose a family, so whether another command already covers the need must be read first | a follow-up of RFC-0011 |
| A persistent index of links | RFC-0037 |
| Pairing sibling repositories by commit graph | RFC-0011, partly built |

## Slices

| # | Slice | Gate expectation |
|---|---|---|
| 1 | The probe of Part B | none |
| 2 | `ProtocolPlugin`, the two plugins, registered ids; literals removed from the core | none |
| 3 | Internal links listed and followed | `workspace:+`, and the families the probe names |
| 4 | Trace through a decided link | `trace:+` with a workspace |

## Open questions

| # | Question | Recommendation |
|---|---|---|
| 1 | Does Part A wait for RFC-0035? | It needs only RFC-0035's registered identities (its step 1). The rest is independent |
| 2 | Are internal links part of the same list as cross-repository links? | No: a separate section. Readers of today's list keep its meaning, and ADR-0051 is met because nothing is hidden |
| 3 | Does a trace through a link cross more than one hop? | Yes, under the same budgets. A chain of services is the case that most needs it, and a budget that runs out is an explicit cut |
| 4 | Which schema-first protocol comes first? | Not chosen here. The baseline ledger and the cross-stack class of the outcome control decide (RFC-0031) |
