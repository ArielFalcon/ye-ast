# RFC-0011: Cross-repository impact

- Status: Draft, 2026-11-01
- Related: [ADR-0001](../adr/0001-product-scope-and-priority.md), [ADR-0010](../adr/0010-trust-modes.md),
  [ADR-0013](../adr/0013-coverage-grows-only-with-evidence.md),
  [ADR-0014](../adr/0014-angular-and-spring-from-own-extractors.md), [ADR-0015](../adr/0015-index-reuse-by-content.md),
  [RFC-0001](0001-architecture-and-layers.md), [RFC-0002](0002-facts-contract.md),
  [RFC-0004](0004-deterministic-map.md), [RFC-0006](0006-configuration.md), [RFC-0007](0007-extension-model.md),
  [RFC-0009](0009-extraction-from-qayaba.md), [RFC-0010](0010-impact-queries.md),
  [ADR-0016](../adr/0016-remote-refresh-under-trusted.md)

**In short:** `TopologyQueries` composes RFC-0010's per-repository pieces over a finite set of links, each from a call
site in one repository to an entrypoint of another. Upstream, a change in B reaches the call sites that target B's
changed or reached entrypoints, and `impact.callers` in the repository of each call site finds what depends on it;
downstream, the call sites a change reaches lead to the entrypoints they target. Each hop repeats until no new link
appears, so FE to BE to BE ends without a bound. The answer holds one section per declared repository, each a fact of
its own snapshot, plus the workspace's snapshot list. Under `trusted` the other repositories are read from ye-ast's
mirrors refreshed from their declared remotes, at the branch a deterministic rule chooses; every call site ye-ast cannot resolve in a declared repository is
a cut, never silence.

## Why

The owner (translated, 2026-11-01): impact "must correctly detect code relationships in several scenarios such as
crossing repositories (frontend to backend, or between microservices, and even the combination of both). It must also
be agile, because it will be used constantly; it must reuse computations safely, identifying well where data is safe to
serve cached and where to verify [...] without falling into the psychosis of covering every possible edge case before
having solid foundations." RFC-0010 settles the inside of one repository and leaves this composition to a later RFC
(`0010-impact-queries.md:205-210`, decision 12 at `:230`).

qayaba's counterpart works but fails open. Its use case returns `null` when no mirror exists, when the change is empty,
when nothing matched and on any error (`resolve-cross-repo-impact.use-case.ts:70,73,120,123-127`); its HTTP resolvers
swallow a failure into an empty result (`http-backend-resolver.adapter.ts:44-50`); an unresolved call is a list the
caller may ignore (`openapi-http-resolver.adapter.ts:299-308`). All paths below are qayaba@main.

## The link

```ts
interface CallSite {              // a fact of one repository at one snapshot; cached per snapshot
  repo: string; file: string; line: number; endLine?: number;
  symbol: string;                 // the enclosing symbol, by the entrypoint join of RFC-0010
  transport: "http" | "event";
  target: Finding<HttpTarget | EventTarget>;
}
interface HttpTarget { method: HttpMethod; path: string; base?: Finding<string>; operationId?: string }
interface EventTarget { protocol: "kafka" | "rabbit" | "jms" | "event"; destination: string }  // role: publish

interface Link {
  id: string;                     // digest of every field below but confidence
  from: { repo: string; file: string; line: number; symbol: string };
  to: { repo: string; kind: Entrypoint["kind"]; name: string; handler: Handler };
  transport: "http" | "event";
  basis: "exact" | "base-path" | "suffix" | "operation-id" | "event-destination";
  profiles?: string[];            // base-path: the profile expressions under which the match holds; absent: default
  confidence: number;
}
```

`HttpTarget.path` is a pattern with parameter placeholders; a segment the evaluator cannot resolve is a placeholder, and
a call whose whole path cannot be resolved has `target` `unknown` (RFC-0007 row A3 supplies the evaluator and the
receivers). `Link.id` has the role of qayaba's `linkIdentity` (`service-links.ts:27-30`) with the line instead of the
symbol, so two calls in one method stay two links. A link is made only by a join of two facts that exist: a `CallSite`
and an `Entrypoint` of the declared repositories; ye-ast runs no repository code (AGENTS.md), and its only network use
is the refresh of declared remotes under `trusted` ([ADR-0016](../adr/0016-remote-refresh-under-trusted.md)).

The TypeScript HTTP evaluator reads lexical bindings, including destructuring, enclosing functions, blocks, catches and
loops; an inner binding wins and a local initializer is evaluated in its declaration's scope. Function-scoped `var`
bindings do not escape nested functions or classes. Immutable AST scopes are memoized by node, and file bindings are
collected once per source instead of rescanned for every request. A `let` or `var` the code assigns again (destructuring
included) is not its initializer and leaves the path undecided, unless every such assignment appends a query or a
fragment (`url += '?q=' + q`), so the path stays the initializer's.

A value the code fills at run time, written `{}`, is a parameter or a variable whose initializer reads one (`this`
included); a variable whose initializer the snapshot does not decide and reads none of them is undecided. A run-time
value stands for one path segment, an approximation: nothing proves it nonempty, free of `/` or other than a dot segment.
It stands for a segment only where it starts one; a run-time value that starts the URL or follows text of its segment
(`${base}/orders`, `/api/v1${path}`) may hold an origin, a base path or several segments, so the path is undecided.

An unshadowed global `encodeURIComponent` is a supported static transformation. It escapes `/`, `?` and `#`, so what it
encodes stays in one segment: a text the snapshot states whole is encoded, and anything else is a run-time value, a text
holding a run-time value or cut at its query included, unless the snapshot cannot read the argument and the argument reads
nothing the code fills at run time. `String(x)` and `x.toString()` write what a template writes for `x`. A shadowed
encoder keeps the evaluation unknown. A visible write or an escaping global object in the provided snapshot
(`fromEvent(window, 'resize')`) leaves an encoded text undecided, while what the call encodes from a run-time value stays a
run-time value: whatever function runs, its result is filled at run time. No repository function is executed. A whole run-time URL such as `fetch(url)` remains unknown when `url` names a run-time parameter.

A wrapper is a verb-named method of a class another class injects that forwards one of its parameters unchanged as the
tail of its request's path (`this.http.get(path)`, `` `${this.url}${path}` ``, `base + '/' + path`, or through a method
of the class that returns its parameter that way); its callers make the requests, with the verb of the request the
wrapper makes, and the caller's path argument joins through the base-path and suffix rungs. A method that writes its
parameter inside a segment (`` `/items/${encodeURIComponent(id)}` ``, `` `/items/${id}/details` ``) is no wrapper: its own
request is the call site.

A receiver `this.x` is the field the class of the call declares (a constructor parameter only when it declares a
property) or inherits from its base class, here or through an import; a bare name is the binding the code around it
declares, then a constant of the file; a parameter's declared type names its value only while the function neither
assigns the parameter nor declares it again with a value, and a local's initializer only while nothing assigns the local.
The file that writes the receiver's type name decides through its imports which class it names.

`fetch(url, init)` takes its method from the init object it states, GET without one; an init that is not an object
literal, or a spread or computed member that may state `method` after it, leaves the method undecided. An
`httpResource` request object's `url` and `method` are read the same way, shorthand included. A `fetch` the file or the
code around declares or imports is not the global one, and its call is no request.

The text after the first `?` or `#` of a URL is its query or fragment, which no route serves: evaluation stops there, so
a value the query names never leaves the path undecided. An argument of `encodeURIComponent` cut there is a run-time
value: the encoder escapes its `?` and `#`, so the whole argument stays in one segment.

A method a path calls (`pageLink.toQuery()`, `this.area()`) is read when its receiver's class is in the snapshot: `this`,
`super`, a field or a parameter whose declared type names the class. The receiver may be any subclass, so the method the
class declares or inherits and every override a subclass declares must write the same, a subclass being any class whose
`extends` resolves to that class through its own file's imports, under whatever name (`super` reads only the inherited
one). A subclass member the snapshot cannot read as a method, such as an accessor, leaves the call undecided. A method that
reads its own parameters is not read, since its arguments are not substituted, nor one that any class of the instance's
hierarchy assigns through `this` (the receiver's class, every class it extends, or a subclass), since the instance then
holds the assigned function.

A function a path calls, and the function an `httpResource` takes its request from, is read at every `return` of its own
body; the functions it declares return their own. A bare `return`, and an end the body reaches without returning, return
`undefined`. Every return must write the same path, otherwise the path is undecided, and a function that calls itself is
undecided. An `httpResource` function that returns `undefined` requests nothing then, so its request is the one its other
returns state. Variables the function declares are values it fills at run time.

A class member the class does not declare (`this.resourceUrl`) is read from the class it extends, in the same file or
through an import; a member the class declares itself wins. A field's initializer is its value only while nothing else
assigns it: a field declared without an initializer or as a constructor parameter, one the reading class or any class it
extends writes (`=`, compound assignments, `++`, `delete`), above the declaring class included, one a subclass of the
reading class declares again or writes, and any field of a class that writes fields it does not name (`this[key] =`,
`Object.assign(this, …)`) hold a value the code fills at run time. Writes from outside the class hierarchy are not read.
A property of a run-time value (`category.id`, `event.data.id`) is a run-time value; a root the code binds is read
through that binding before any class, import or constant of the same name. A member of an enum the file declares or
imports (`UserSettingsType.DOC_LINKS`) is the text its initializer states; a member without one, or initialized by any
other expression, which may name another member of the enum, is undecided.

A name that is neither a binding nor an import of its file, such as an ambient `declare const`, takes the value an
Angular workspace's `build` target states for it in `define` (application builders), read from `angular.json` as source
text: only when every configuration, the default build included, states the same string literal. A configuration's own
`define` replaces the options' one, as the Angular CLI merges configurations. A source takes the define of the deepest
project root above it. A build plugin that rewrites defines is not read.

| Transport | Call-site side | Entrypoint side | Matched by | Confidence |
|---|---|---|---|---|
| http | `CallSite` with `HttpTarget` | `HttpRoute` (`http-route.ts:33-43`) | verb equal or route `ANY`; path segments equal, parameters stand for any parameter, then the base-path ladder below | 1.0; 0.6 when a placeholder of the call consumed a parameter of the route (parity, `openapi-http-resolver.adapter.ts:334-336`) |
| http by contract | generated client call naming an `operationId` | the `HttpRoute` whose handler implements that `operationId` (RFC-0007 row S5) | `operationId` equal | 1.0; no path involved |
| event | publish `CallSite` with `EventTarget` | `Listener` (`entrypoint.ts:5-12`) | same `protocol` and `destination` | 1.0 |
| Spring in-process event | `publishEvent(new X())`, protocol `event`, destination the qualified type | `@EventListener` listener, destination the qualified type (RFC-0007 row S7) | as event; `from.repo` equals `to.repo` | 1.0 |

An in-process event is the same link with one repository, so one code path serves both. qayaba's event resolver also
matches by stem (`Event`, `Model` suffix removed, 0.7) and keeps only the first publisher
(`event-resolver.adapter.ts:23-27,94-98`); ye-ast links every pair on an exact destination and defers the stem
(deferred list).

### Base paths and profiles

A route's `basePath` is a `Finding<BasePath>`: the default keys and the keys each profile expression sets, with no
profile picked and the keys not joined ([ADR-0014](../adr/0014-angular-and-spring-from-own-extractors.md) decision 6;
`http-route.ts:5-23`). The matcher follows the same rule and tries, in order:

| # | Basis | Rule | Result |
|---|---|---|---|
| 1 | `exact` | call path equals the route's `path` | link, no `profiles` |
| 2 | `base-path` | call path equals one key of the base path plus the route's `path`, under the default or a profile expression | link; `profiles` lists every expression under which it holds, so a match that exists under `prod` only is visible as such |
| 3 | `suffix` | one path ends with the other, the extra leading segments are all literals and the shorter path has a literal segment (qayaba's rule, `cross-repo-impact.ts:17-28`) | link, confidence capped at 0.5; for a route whose `basePath` is `unknown`, and for a gateway prefix the workspace declares in `boundaries[]` (RFC-0006) |
| 4 | none | no rule holds | no link; if the call site reached a declared service prefix, an item `unmatched` (qayaba's drift) |

qayaba's pattern also allows up to three unconstrained prefix segments and bounds the source at 200 characters
(`operation-url-pattern.ts:9-12`); both are size constants, which AGENTS.md forbids ("signals, never size thresholds"),
and are not carried: row 3 uses the literal-segment signal alone.

## Upstream, downstream and the chain

Both directions use one primitive per repository: an RFC-0010 inbound walk (`impact.callers`, `0010:30-31`) seeded by
symbols or line ranges. A reached entrypoint carries the indices of the seeds that reach it in `ReachedEntrypoint.seeds`.
The initial outgoing-call selection also uses structural declaration ownership, independently of the inbound walk.

| Step | Upstream: who calls what changed | Downstream: what a change sends onward |
|---|---|---|
| 1. Seed set in repository R | R's `changedEntrypoints` and `entrypoints` from `impact.ofChange` (`0010:119-125`) on the first hop; later, the handlers of the links that fed R | R's symbols from `impact.ofChange` on the first hop; later, the handlers of the links that fed R |
| 2. Join | links whose `to` is a seed entrypoint (a removed or altered route also matches against the merge base's entrypoints, which RFC-0010 extracts, since consumers of the old path break) | on the first hop, call sites whose immediate owner or verified named AST ancestor matches a changed seed's file, simple name and declaration span; later, call sites whose inbound walk reaches the fed handler |
| 3. Next repository | the repository of each link's call site; `impact.callers` seeded by that call site's line range finds its symbols and reached entrypoints, which are the seeds of the next join | the repository each link lands in; one `impact.callers` walk seeded by all of that repository's call sites keeps the call sites whose walk reaches the fed handler (`seeds` states which), which are the links out of it |
| Stop | no link not yet admitted | same |

Structural ownership selects calls written inside a changed class or outer function, including nested declarations.
`CallSite.ancestors` records the source AST's named enclosing declarations with their line spans, nearest first. A
matching ancestor must fit within the seed's span; position alone never joins unrelated names. This selection does
not add dependency edges: `reachedBy` still joins each walk seed to a call site's immediate owner using file, line
span and simple name. Unsupported or dynamic calls remain subject to the extractor's declared coverage.

The sequence is a fixpoint over the finite set of links: a link enters the answer once, keyed by `Link.id`, and a
repository is walked again only when a fresh link feeds it. No hop count or size constant ends it, as in qayaba's
`LinkGraph` and `LinkWalk` (`link-graph.ts:1-4,16-75`). Each link in the answer carries `reach`: the direction and the
`Link.id`s crossed from the change, nearest first (qayaba: `ImpactReach`, `service-links.ts:45-61`). A removed route
whose consumers still call it is the cross-repository case of RFC-0010's "a removed route is the change that breaks its
consumers" (`0010:66`). A contract operation whose request or response data the change altered, or that the change
removed (RFC-0010 `changedContracts`), seeds the same join through the handlers of the routes its contract join made:
the routes of the operation's verb, overriding its `operationId`, whose evidence holds its place, at head for an altered operation and at the merge base for a
removed one. The trigger's `changedContracts` carry those `handlers`; an operation no route of its snapshot joins
names no caller and cuts the trigger's section at its place (`unresolved-link`), since its callers cannot be told. A link that lands in such a handler carries the operations as `operations`: its call site calls the
operation, which does not establish that it reads the data that changed. The link keeps the confidence, basis and
ambiguity the join gave it; a call two repositories serve equally stays a cut. An added operation seeds nothing.

## The workspace

| Question | Rule |
|---|---|
| Which repositories | Those the manifest's `repos[]` declares (RFC-0006), supplied by the host under `untrusted` ([ADR-0010](../adr/0010-trust-modes.md)). Never discovered. Under `trusted` a repository with a `remote` URL is read from ye-ast's mirror, refreshed before the query ([ADR-0016](../adr/0016-remote-refresh-under-trusted.md)); under `untrusted` the host materializes every mirror and ye-ast makes no network request (qayaba refreshes a mirror best-effort, `resolve-cross-repo-impact.use-case.ts:76`) |
| Which snapshot of each | The trigger repository takes `base` and `head` as in RFC-0010; `live` follows RFC-0010 slice 3 and `trusted` only. Every other repository takes the sha the rule below chooses, pinned once before the first hop |
| Completeness is relative to | The declared repositories and each one's declared scope (RFC-0002 rule 4): a route with no consumer is "none in the declared repositories", never "no consumers" |

### Which snapshot of each

The rule reads only the commit graph and the ref listings, never dates or reflogs, so the same graph and listings give
the same shas. It runs in both modes: under `trusted` over the listings the refresh records, under `untrusted` over the
refs of the mirrors the host provides.

| Step | Rule |
|---|---|
| 1 | An explicit revision for the repository (`--repo-rev <id>=<rev>`, or the host's parameter) wins |
| 2 | The trigger's line: the checked-out branch name when it equals a line the manifest declares, or matches a declared pattern (`release/*`). Otherwise, with H the trigger's head, fork(L) is the first commit on H's first-parent chain that line L reaches; L is a candidate only if fork(L) is on L's own first-parent chain; the candidate with the fewest first-parent steps from H to fork(L) wins, a tie goes to the line declared first and is recorded. A detached head follows the same rule |
| 3 | Coordinated branches, only when the manifest opts in: when the other repository's listing has the trigger's branch name and the tip of that repository's line does not already contain it, that branch is read |
| 4 | The trigger's line in the other repository, through the repository's declared line mapping (`qa` read as `staging`) |
| 5 | With no lines declared, the default branch the remote's own listing names (`ls-remote --symref`), never a clone's `origin/HEAD`, which does not follow a change of default |
| 6 | A chosen branch absent from the repository's listing, or no candidate line in step 2, makes that section `unknown` with reason `revision-unavailable`; never another branch silently |

The step that chose each sha, the refs consulted with their shas, ties, and a same-named branch left unused when
coordination is off go in the resolution record of the response, never in the fact
([ADR-0016](../adr/0016-remote-refresh-under-trusted.md) decision 4). A replay that passes the recorded shas gives
byte-identical facts. Entries of `repos[]` that point into one repository share the trigger's sha with no resolution.
The step-2 rule reads the trigger's local clone, so it needs no network: a stale local line tip is a first-parent
ancestor of the real one and picks the same line. A merge that rewrites a line's first-parent chain ("foxtrot" merge)
can mislead step 2 and is deferred.

### The envelope

```ts
interface WorkspaceImpactValue {
  workspace: { manifest: string; repos: string[] };       // digest of the manifest; declared repository ids, sorted
  repositorySnapshots: { repo: string; snapshot: SnapshotRef }[];  // one per repository read, sorted by repo
  trigger: { repo: string; mergeBase: string };
  sections: Record<string, Fact<RepoImpact>>;              // one fact per repository, at its own snapshot
  links: ImpactedLink[];                                   // { link, direction, reach: string[], operations?, detail }
}
interface RepoImpact {
  reads: { kind: "discovery" | "trigger" | "upstream" | "downstream"; fact: FactProvenance }[];
  impact?: ImpactValue;
  callSites: CallSite[];
  unmatched: CallSite[];
  external: CallSite[];
  unresolved: UnresolvedCallSite[];                         // the section's discovery record; the cut stays, no link
}
```

Each section is an RFC-0002 fact of its repository (`fact.ts:67-96`); the composite follows rule 2
(`composeSections`, `fact.ts:101-108`): `complete` only when every section is, otherwise `partial` with one `section`
cut per incomplete section, whose own fact carries its cuts or its `unknown` reason. The envelope's `snapshot` field is
one `SnapshotRef` (`fact.ts:69`); it names the trigger repository's head, and the full list is
`value.repositorySnapshots`, a minor schema change (RFC-0002 rule 6), not a change of the union. Order: sections by
repository id, links by `Link.id`, repository snapshots by repository. Redaction at egress applies to every section
like `map`.

`FactProvenance` retains a read's complete envelope without its `value`: snapshot, producer, inputs, evidence and
`complete`, `partial` with cuts, or `unknown` with its reason. Each section retains discovery and every walk that
contributed. An unknown walk alongside known discovery makes the section partial; its named reason and any independent
cuts remain available together. The trigger walk uses the SHA discovery already resolved, and its declared selection
and bounds remain the composite's declared configuration.

The transport carries `repositoryRoots` (declared clone roots) and the internal workspace read carries
`repositorySources` (actual snapshot locations, including mirrors). Neither belongs in the fact. A consumer walk reads
the pinned SHA from its source and resolves trust against its declared clone; a mirror's path cannot replace the
repository's trust identity. MCP exposes clone roots for navigation and omits internal sources.

Invalidation (RFC-0002 rule 5), per section and for the composite:

| Level | Valid while |
|---|---|
| a section | the sorted identities and snapshots of all its contributing reads, their statuses and limits, and its declared configuration are unchanged |
| the composite | every contributing read's identity and snapshot, the repository and gateway declarations, and the requested targets, change selection and bounds are unchanged; a change read includes its resolved merge-base SHA even when the tree bytes match another commit |
| a new repository declared | the manifest digest changes, so the stored fact is invalid; a consumer added later cannot leave a stale `complete` |

## Reuse: cached and verified

Everything below is keyed by content, so it is immutable and needs no age or refresh. Links are joined at query time
over the cached pieces: a join over two small tables costs less than keeping a joined store coherent across
repositories.

| What | Keyed by | Served from cache | Verified on every call |
|---|---|---|---|
| index of a repository | staged content digest plus engine versions ([ADR-0015](../adr/0015-index-reuse-by-content.md) decision 1) | always | nothing; the key is the check |
| entrypoints of a repository | the content digest of RFC-0002 rule 5 | always | nothing |
| call sites of a repository | the same content digest, the evaluator version, the digest of the `boundaries[]` call patterns and the environment files the evaluator read | always | nothing |
| egress table (which handler reaches which call site) | the index key plus the call-site set | always; built lazily for the handlers a query needs | nothing |
| a section fact | its `inputs` | yes, unless a deadline cut it; never an `unknown(index-unavailable)` | the `inputs` equal the current ones |
| the link set and the walks | not stored; recomputed from the above | no; a walk is about 10 ms on 18,004 nodes (`0010:177-178`) | n/a |
| revision to sha, per repository | not cached; the last ref listing per mirror is kept for when a refresh fails | no | refreshed and resolved on every explicit query ([ADR-0016](../adr/0016-remote-refresh-under-trusted.md) decision 9), since a branch moves; the cached pieces of the old sha stay valid. Hooks read the last listing and report it `unverified` |
| step-2 line classification | (head sha, line tip shas) | always | nothing; the key is the check |
| the manifest | its digest | n/a | digest compared on every call |
| a `live` tree | `stateId`, in memory only (RFC-0005) | checked on every query | `stateId` |

One consequence: a commit in consumer A leaves B's pieces untouched, and one that changes nothing in A's scope leaves
A's digest unchanged, so the composite is recomputed from cached pieces without a build.
A cold repository costs one index build; the content key removes the repeats.

## Completeness

| Cause | Where | Result |
|---|---|---|
| call site in a declared repository whose `target` is `unknown`, and whose known parts (verb, literal segments) are compatible with a seed entrypoint | the call site, as `repo:file:line` | cut `unresolved-link` at those call sites; the composite is `partial` |
| a call site that cannot be told from a candidate, because the evaluator cannot resolve the base URL (environment file absent; RFC-0007 row A3) | the call site | same cut, unless `boundaries[]` declares the prefix, which gives the `suffix` basis |
| a route whose `basePath` differs by profile, or is `unknown` | the link | link with `profiles`, or `suffix` basis; never a silent pick |
| a declared repository that cannot be read or indexed | its section | section `unknown` with its reason; composite cut `section` at the repository |
| no copy of the chosen revision, or no branch the rule can choose | its section | section `unknown(revision-unavailable)`, never stored; composite cut `section` |
| a remote whose refresh failed | the response's freshness | nothing in the fact: the section is about the pinned sha; the freshness says `unverified` with the reason |
| a changed or walked file with no extractor, or outside the declared scope, in any repository | RFC-0010 cuts of that section | unchanged; reach the composite as a `section` cut |
| a language with no call-site extractor in a consumer (Kotlin, for example) | that repository's source files | cut `no-extractor` at the files; the repository is never counted as "no consumers" |
| a call site that targets a service no declared repository serves | the call site | item `external` in the section, not a cut: the boundary of the workspace is its declared repositories, and the fact says so in `workspace.repos` |
| a repository that consumes B but is not declared | nowhere | invisible by construction; the stated scope is the only protection (RFC-0002 rule 4) |
| a budget stopped a walk (RFC-0010 `budget`) | that section | the section's `depth`, `hub` or `caller-budget` cut |

`complete` holds only when every cut-causing case above is absent. An empty `links` with `complete` means "no link
within the declared repositories"; with any `unresolved-link` cut it means nothing about the call sites in the cut.

## Placement

| Piece | Where |
|---|---|
| `Link`, base-path ladder, event matching, link identity, the fixpoint over links (`LinkGraph`, `LinkWalk`) | `core/domain/topology/` (pure) |
| the workspace use case: hops, joins, composition of sections | `core/application/topology/`, over the `ImpactQueries` and `EntrypointQueries` ports |
| the call-site extractors (HTTP receivers, publishers) | the protocol plugins of RFC-0007, in `core/adapters/` per technology; the HTTP evaluator is row A3 |
| `TopologyQueries` port, workspace request | `core/ports/` |
| OpenAPI documents and operation diff | `core/adapters/openapi/` |
| CLI `ye-ast impact --workspace`, MCP and protocol methods | `cli`, `mcp`, `protocol`, wired in `composition` |

## Slices

Each slice is accepted by containment against qayaba, as RFC-0010: what qayaba's resolvers link from the same call sites
is linked, or its absence is explained by a row of this RFC, and each extra link traces to a basis.

| Slice | Delivers | Depends on | Accepted by |
|---|---|---|---|
| 1 | `CallSite` and `Link` types; HTTP join (exact, base-path, suffix, operation-id); upstream, one hop; two-repository workspace; envelope with sections, repository snapshots, cuts; the snapshot rule and the refresh of ADR-0016 | RFC-0010 slice 2 (`impact.callers`); call sites from RFC-0007 row A3, or qayaba's extracted call sites as test input for parity | a fixture per basis and per cut; byte-identical output twice; join parity on a real FE and BE pair: every link `openapi-http-resolver` and `http-backend-resolver` make is made |
| 2 | the fixpoint: chains FE to BE to BE; downstream; `reach`; egress table | slice 1 | chain fixtures with a cycle; parity with `resolveUpstreamHop` and `resolveDownstream*` (`use-case:150-233`) |
| 3 | events: listeners (RFC-0007 row S7), publish call sites, Spring in-process events | the events protocol plugin | a fixture per protocol; parity with `event-resolver` on exact matches |
| 4 | contract tier: operation diff seeds; per-pair join cache if measurements justify it; protocol and MCP methods | RFC-0005 first protocol slice | operation-diff fixtures; parity with the `contract-file` tier |

What moves from qayaba, and what is rewritten:

| Moves (pure, with its tests) | Rewritten |
|---|---|
| `LinkGraph`, `LinkWalk`, the link vocabulary and `linkIdentity` (`service-links.ts`); `operation-diff.ts`; the OpenAPI ingress parsing | the use case (the `null` returns and `catch` become facts; `existsSync` and mirror refresh, `RFC-0009:86-87`, are dropped) |
| `routeServesOperation`'s segment rule, as basis 3 only | the HTTP resolvers: they rescan whole repositories on every call and read text with regular expressions; here call sites come from the plugins and are cached per snapshot |
| confidence values 1.0, 0.6 | the event resolver (first match, stem) and the `operationUrlPattern` constants |

Deferred until the base is measured: stem matching of events; a cut for name-matched links that point at the wrong
service; gRPC, GraphQL and `rpc` links (qayaba's `transport` admits `"rpc"` with no producer); gateway routes and
`spring.application.name` as service identity (RFC-0007 row S6 "Not built"); client base URLs of `@HttpExchange` groups;
interceptors that rewrite URLs; field-level contract drift; a per-pair link cache; a live tree as a consumer.

## Decisions

Answered by the owner on 2026-11-01; questions 1 and 5 were revised after the owner's objection, then corrected by an
independent review.

| # | Question | Decision |
|---|---|---|
| 1 | Which revision does a non-trigger repository take when the caller names none? | The rule of "Which snapshot of each": explicit revision, the trigger's line by the first-parent rule, opt-in coordinated branches, the declared line mapping, the remote's default branch, otherwise `unknown(revision-unavailable)`; the chosen step is recorded in the response |
| 2 | Is a snapshot list beside the single `snapshot` of the envelope enough? | Yes, as `value.repositorySnapshots`, `{ repo, snapshot }` per repository: a minor schema change; the envelope's `snapshot` names the trigger repository's head |
| 3 | Does the `suffix` basis (qayaba's gateway tolerance) stay? | Yes, capped at 0.5 and marked, so parity holds; it shrinks as `boundaries[]` declares prefixes |
| 4 | Do events match by stem, as qayaba's resolver does? | No: exact destination only; a name heuristic enters under ADR-0013 rule 4 with evidence |
| 5 | May ye-ast fetch a `remote` repository? | Under `trusted`, yes: into its own mirror with the user's git, before the query, by [ADR-0016](../adr/0016-remote-refresh-under-trusted.md); under `untrusted`, no: the host materializes every mirror |
| 6 | First slice: upstream HTTP only? | Yes; downstream and events follow once the join is measured |
| 7 | Is an unresolved call site a cut even when nothing is known about its target? | Yes: a call site with nothing known is compatible with every seed and cuts; only a known part that contradicts a seed (the verb, or a literal segment) excludes it |

## Evidence from a real workspace (2026-11-01)

A probe on a real product (one Angular 21 frontend, five Spring Boot services, a shared event-contracts library, a
shared REST-client library and a Maven governance repository, all sibling clones) tested the assumptions above. Each
row states what the product does, what this RFC assumed, and what the design needs.

| # | What the workspace does | Assumed here | Needed |
|---|---|---|---|
| E1 | Routes are spec-first: `src/main/resources/openapi/api-definition.yaml`; the generator runs with `interfaceOnly` from a parent POM that lives in another repository (`<relativePath/>`), so no service's own build names the spec; every controller `implements` a generated `*Api` that is absent from the source. Today every route is `unknown(no-extractor)` | routes come from the Spring extractor | RFC-0007 row S5 first: the `operationId`s of a contract document in the repository joined to the override methods of a class whose `implements *Api` does not resolve. Without it no HTTP link can exist in this workspace |
| E2 | Two services hold the generator's sample contract (20 operations, `basePath: /v2`) with no implementer | — | S5 makes a route only where a class implements the operations, so an unimplemented contract makes none, by construction; a test pins it |
| E3 | No contract declares `servers` and no service sets a context path; the frontend sends every call to one gateway host (`API_BASE_URL`) with a first segment naming the service (`name-orders-api/orders/checkout`); the gateway's API definitions live in no repository | base path from `servers` and configuration; a gateway prefix declared in `boundaries[]` gives the `suffix` basis at 0.5 | `boundaries[]` declares each gateway prefix and the repository it routes to; question 8 |
| E4 | About 22 frontend call sites, all through one wrapper (`this.rest.<verb>(path, options)`) that resolves `apiBaseUrl + "/" + path`; paths are exported constants composed by template literals across files (`${ORDERS_PATH}/checkout`), `:id` placeholders filled from `pathParams`, and one path built by a function | A3's parameter-flow summaries | A3 limited first to wrappers `boundaries[]` declares (receiver type, verb per method, path argument), with constants and template literals resolved through the TypeScript compiler across imports; `${expr}` and `:name` become parameters; anything else is `target: unknown` and cuts |
| E5 | Service to service HTTP goes through a shared client library by keys (`systemKey`, `urlKey`) that each service's `application.yaml` maps to a URL (`systems.<s>.endpoints.<k>.url`) | `RestTemplate`, `WebClient`, `@HttpExchange` receivers | a call pattern in `boundaries[]` naming the builder methods that carry the keys and the configuration path that holds the URL; Java call sites are a slice of their own |
| E6 | Events are core NATS: publishers send `"<prefix>." + id` or a constant prefix plus an expression; listeners subclass a base type from a jar that is not in the workspace and override `getSubject()` returning `<prefix>.*` constants from the shared event-contracts repository, with queue groups | protocols `kafka`, `rabbit`, `jms`, `event`; exact destination (decision 4) | `nats` in `EventTarget.protocol`; listener and publisher shapes declared in `boundaries[]` (base type, subject method, publish method and argument); subject constants resolved across declared repositories; matching by the protocol's own token rule (`*` one token, `>` the rest); question 9 |
| E7 | Subject constants and their wildcards live in a library repository that no service runs | every repository is a service | a repository role `library` in `repos[]`: read for constants, never walked for impact |
| E8 | qayaba holds no recorded link set for this workspace, only hand-written fixtures | slices accepted by parity with qayaba | acceptance by a hand-verified inventory of the real links (kept outside the repository, since the product's code is not ours to publish) plus synthetic fixtures in the repository with the same shapes; parity with qayaba where it links at all |
| E9 | The owner reaches ye-ast through the MCP, which binds one repository | MCP methods in slice 4 | a workspace tool in the first delivery that links anything; question 10 |
| E10 | Drift found by hand: the frontend calls `restaurants/daily-menus` where the contract serves `/daily-menus`; calls to services with no repository (`name-geo-api`, a promotions service); a publisher whose subject is itself a wildcard; a reward-points endpoint no contract declares | `unmatched` and `external` items | the inventory keeps them as expected `unmatched` and `external` results, so a fix that hides drift fails acceptance |

### Revised slices

The table above moves contract routes and declared call patterns ahead of the join, since without them the first slice
links nothing in a spec-first workspace.

| Slice | Delivers | Accepted by |
|---|---|---|
| 0 | RFC-0007 row S5: contract routes joined to implementing overrides, in the single-repository `map` and `impact` | every operation of the three implemented contracts is an `http-route` with its handler; the two sample contracts make none; an override with no operation stays `unknown` |
| 1a | The workspace manifest: `repos[]` (id, path or remote, role `service` / `frontend` / `library`, declared lines) and `boundaries[]` (gateway prefixes, call patterns, event patterns), its digest, and the snapshot rule over local refs (steps 1, 2, 4 and 6; the freshness says `unverified` until ADR-0016's refresh lands) | manifest fixtures; a replay with the recorded shas is byte-identical |
| 1b | Frontend call sites for declared wrappers, with cross-file constant and template-literal resolution | the 22 call sites of the inventory, each `known` or a cut with its place |
| 1c | `core/domain/topology`: `CallSite`, `Link`, the ladder with the declared gateway prefix, upstream one hop, the envelope with sections and repository snapshots; CLI `impact --workspace` and an MCP workspace tool | the inventory's frontend-to-service links, its `unmatched` and `external` items, byte-identical output twice |
| 2 | The fixpoint over links, downstream, `reach` | a chain frontend to service to service in the inventory |
| 3 | Service-to-service call sites through declared key-based clients | the inventory's three service-to-service links and their external targets |
| 4 | NATS events: declared listener and publisher shapes, subject constants from a `library` repository, token matching | the inventory's four publisher-listener pairs, its listener with no publisher and its publisher with no listener |
| 5 | ADR-0016 remote refresh, contract operation diff, the deferred list above | as before |

### Decisions from the evidence

Answered by the owner on 2026-11-01: "Aceptar las 4 (Recomendado)".

| # | Question | Decision |
|---|---|---|
| 8 | A gateway prefix `boundaries[]` declares with the repository it routes to: `suffix` basis at 0.5 (row 3), or an exact match after the declared prefix is removed? | Exact, basis `gateway-prefix`, confidence 1: the mapping is declared by the user, not guessed; `suffix` stays for a route whose base path is `unknown` |
| 9 | NATS subjects: does decision 4 (exact destination) allow the protocol's own wildcard rule? | Yes: `*` and `>` are the subscription semantics of the protocol, not a name heuristic; a publisher subject with an unresolved suffix is a pattern whose unknown tokens match one token each, at confidence 1 when every literal token matches |
| 10 | The MCP surface: slice 4 as planned, or with slice 1c? | With 1c: a tool `ye_ast_workspace_impact` beside the four single-repository tools, bound to the manifest the server is started with |
| 11 | Who writes `boundaries[]` for a workspace? | The user or the host, in the manifest; ye-ast validates it and reports each declared pattern that matched nothing, so a stale declaration is visible |

## Second revision: discovery and zero configuration (2026-11-01)

The owner (translated): the list of repositories "could be deduced by following the chain of interaction: a frontend
usually names the microservices it calls, these can be searched on GitHub, and so on [...] the idea is that the MCP is
transparent for the user; the other is that the LLM passes the information needed for the initial configuration
[...] reusable for any project, solid and reliable, with features that are really useful for the LLM". The first
revision coupled the slices to the probe workspace (declared wrappers, a key-based client library, a NATS library);
this revision replaces that with one rule:

> Everything the code states is read without configuration. What no repository states is supplied by the agent or the
> user per request, and ye-ast says exactly what is missing. A declaration only overrides or completes a derivation.

### Discovery: ye-ast derives the evidence, the agent follows the chain

Following the chain is viable, split at the engine's boundary: deriving the names is a fact about code; searching a
code host, cloning and deciding are not.

| Part of the chain | Who | Why |
|---|---|---|
| What a repository names outward: hosts and paths of its HTTP call sites, gateway prefixes, configuration URLs (`http://<service>:<port>/...`), message destinations, dependencies with their coordinates (`pom.xml`, `package.json`), its own remote and the registries it declares | ye-ast, as facts with evidence | deterministic reads of the snapshot; no network; works under `untrusted` |
| Matching a named service to a repository already on disk (sibling clones and their remotes) | ye-ast, as candidates with a basis (`exact-name`, `artifact`, `remote`, `route-overlap`), never as links | name equality and route overlap are checkable; anything weaker is a candidate the agent confirms |
| Searching GitHub or another host for a name with no local repository, cloning it, asking the user | the agent, with its own tools and the user's permissions | a network request steered by repository content is a supply-chain vector, and ye-ast's only network use stays ADR-0016's refresh of declared remotes; the agent's harness shows the user every clone |
| Iterating: each repository added names the next ones | the loop between both | ye-ast reports each outward name no given repository serves; the agent resolves it and calls again; the chain ends when nothing new is named |

Gateway prefixes need no declaration either: a prefix P routes to repository R when at least one call under P matches a
route of R once P is removed, no call under P matches a route of another repository, and the rest match nothing
(basis `route-overlap`, those rest kept as `unmatched` drift). Two repositories matching under one prefix is a cut, not
a pick. A declared prefix (decision 8) overrides the inference.

### Surface for the agent

Read-only toward agents holds: no MCP tool writes a manifest. The workspace is a request parameter; it is persisted
only by the user through `ye-ast init --workspace`, which writes ye-ast's own fixed layer.

| Tool | Answers | Replaces |
|---|---|---|
| `ye_ast_workspace` | the outward names of the bound repository (and of any `repos` passed), each with evidence, the local repositories that serve each one with their basis, and the names nothing given serves | the manifest as a prerequisite |
| `workspace` parameter on `ye_ast_callers` and `ye_ast_impact`: `{ repos: [{ id?, path }], gateways?: [{ prefix, repo }], patterns?: ... }` | the same answers crossing repositories: the consumers in other repositories of a route, a handler or a destination the walk reaches, and the links a change sends onward | `ye_ast_workspace_impact` (decision 10): one tool per question, not one per scope |

Repositories the agent passes are local paths only, each read under its own trust declaration (`untrusted`, from a sha
export, unless the user declared it `trusted`), so passing a path never widens what ye-ast may execute or fetch.

### Coverage without configuration

| Shape | Source of truth | Configuration |
|---|---|---|
| Routes: Spring annotations; contract-first routes (OpenAPI or Swagger `operationId`s joined to the overrides of a missing generated interface, row S5) | code and contract documents | none |
| Frontend calls: `HttpClient` verbs, `HttpRequest`, `httpResource`, `fetch`; wrappers derived by parameter-flow summaries (row A3, as designed), never "any call with a path" | code | none |
| Base URLs: environment files, configuration properties | code and configuration | none; an absent one is `unknown` |
| Service-to-service HTTP: `RestTemplate`, `RestClient`, `WebClient`, Feign, `@HttpExchange`; URLs from `@Value` and configuration properties (row S6) | code and configuration | none |
| Events: Kafka, Rabbit, JMS, Spring application events, and NATS's own client API (`publish`, `subscribe`), each with its destination; matching per destination, with NATS token wildcards (decision 9) | code | none |
| A company library whose source is in a given repository (a messenger or REST-client wrapper) | its code, through the same parameter-flow summaries | none when its source is given; otherwise every call through it is a cut naming the library |
| A library with no source anywhere, a gateway whose routing is in no repository and no overlap decides | nothing | `patterns` or `gateways` in the request; until then a cut that names exactly what is missing |
| Languages and frameworks outside the declared scope (React, Node, Python, Go...) | — | not covered: `no-extractor` cuts; coverage grows by ADR-0013 |

### Slices, third order

| Slice | Delivers | Accepted by |
|---|---|---|
| 0 | Contract routes (row S5) in single-repository answers | as before |
| 1 | `ye_ast_workspace`: outward names and local candidates, with evidence and basis | the probe workspace's names (prefixes, configuration hosts, artifacts) each found with its evidence; synthetic fixtures for every source and basis; a name nothing serves listed as such |
| 2 | Frontend call sites for the standard clients and derived wrappers (row A3 minimum: constants and template literals across imports, one level of parameter flow) | the probe's call sites known or cut, with no declaration |
| 3 | The join with `route-overlap` prefixes; `workspace` on `ye_ast_callers` and `ye_ast_impact` (upstream one hop); the envelope | the probe's frontend-to-service links and drift items with only `repos` passed |
| 4 | Service-to-service call sites for the standard clients and configuration URLs | synthetic fixtures for each client; the probe's key-based library through its source in `name-rest-clients`, or a cut naming it |
| 5 | Events with destinations for the standard brokers and NATS's client API; library wrappers through their source | a fixture per broker; the probe's pairs, or cuts naming the library whose source is absent |
| 6 | The fixpoint over links, downstream, `reach`; `ye-ast init --workspace` to persist; ADR-0016 refresh for persisted remotes | chains in fixtures and in the probe |

### Decisions revised

Accepted by the owner on 2026-11-01: "Confirmo todo".

| # | Revision | Status |
|---|---|---|
| 8 | A declared prefix stays exact at confidence 1, and becomes an override: without one, `route-overlap` infers it | accepted |
| 10 | No `ye_ast_workspace_impact`: a `workspace` parameter on `ye_ast_callers` and `ye_ast_impact`, plus `ye_ast_workspace` for discovery | accepted |
| 11 | `boundaries[]` is optional: request `patterns` and `gateways` complete what the code does not state; ye-ast reports each one that matched nothing | accepted |
| 12 | Discovery: ye-ast derives outward names and local candidates; searching a code host and cloning belong to the agent; ye-ast makes no network request for discovery | accepted |

## As built

- Slice 0 (S1): carried by the entrypoints family, not by `TopologyQueries`. A contract document is a YAML or JSON file
  with an `openapi` or `swagger` path segment whose root declares OpenAPI 3.x or Swagger 2.0; the map exports and digests
  it, and its `operationId`s join the `@Override` methods of a controller whose one absent supertype is an interface with
  no class mapping of its own (RFC-0007 row S5 "as built"). The two sample contracts of an unimplemented generator emit
  no route, and an operation no override names emits nothing, as designed.
- A contract's `servers` are read as no path prefix: a route's path is the contract's, its base path is its module's
  configuration. Deferred with the link bases.
- Slice 1 (`ye_ast_workspace`): the tool answers the outward names of the bound repository and of any `repos` passed, the
  local repository that serves each name with basis `exact-name`, `artifact` or `remote`, and the names nothing given
  serves; `route-overlap` waits for the join. The name compared with a repository is its service label — the first host
  label, the first path segment, the last coordinate segment, or the repository name a remote ends with — so a
  configuration URL of `http://<service>.<domain>:<port>/…` names `<service>`. A name written twice is one name with both
  places. Two repositories asked under one id is a fault, never one answer for both. Each section carries the call sites
  the snapshot could not resolve as `unresolved-link` cuts, so a section is `partial` while any remains.
- The link map (`ye_ast_workspace`, fact schema `0.18.0`): the workspace answer runs the same join as the workspace
  impact, from one module (`workspace-join.ts`), over every call site of every repository read, and answers each `Link`
  it admits once, sorted by id, with no walk: no `direction`, no `reach`. The call sites it reaches without a link are
  `unlinked`, `unmatched` (a declared service none of whose routes takes the call) or `ambiguous` (several entrypoints at
  one rung, with the repositories), and an ambiguous one is also an `unresolved-link` cut of its section, as in the
  impact. `workspace.gateways` is the gateways in force, declared (`gateway-prefix`) and inferred (`route-overlap`).
  A published destination is an outward name of kind `destination`; the repositories that serve it are those the join
  linked or found ambiguous for it, with basis `event-destination`, never a name compared with an identity. Composed
  with `ye_ast_callers` or `ye_ast_impact` over the same snapshots, a link both admit is one `workspace-match` relation
  with one attestation per answer.
- Slice 2 (frontend call sites): RFC-0007 row A3 "as built" holds the shapes; the reader is the same one the join uses.
- Slice 3 (the join): `workspace` on `ye_ast_callers` and `ye_ast_impact` is `{ repos: [{ path, id?, revision? }], gateways?: [{ prefix, repo }] }`;
  `live` is refused with it, because a workspace reads committed snapshots only. The bound repository is the trigger: its
  walk (`impact.callers`, or `impact.ofChange` for a change) gives the routes reached, and a removed route is rebuilt from
  the change's `METHOD path` name so its consumers still link. Every other repository's call sites are matched, one hop
  upstream, against the routes of the repositories given other than their own, by the ladder `exact`, `gateway-prefix`
  (declared), `route-overlap` (inferred), `base-path`, `suffix`; at one rung a literal segment beats a parameter, and two
  repositories at one rung are a cut, never a pick. A call under a gateway prefix never falls to a lower rung: when it
  matches no route of the repository the prefix routes to, it is `unmatched`. A link counts only when it lands in a
  reached route; a call to a route the walk did not reach is neither a link nor drift. `reach` of a one-hop link is its own
  `Link.id`. A repository holding an impacted call site is walked with `impact.callers` over that call site's line, at the
  snapshot read, so the answer also names what depends on the call site there (a frontend's UI routes, for instance). A
  call site whose target the code does not decide joins nothing and stays an `unresolved-link` cut of its repository's
  section; so does a call two repositories serve equally. Each unresolved call site carries the declaration it is
  written in, its transport, the library it goes through and, when only the base is undecided, the request the code
  writes (`GET /route`), so the text settles it without opening the file. Sections are sorted by repository and carry
  that repository's own snapshot and trust; the answer's own trust is the bound repository's. `ye_ast_workspace` no
  longer answers the repositories it read (absolute paths and every entrypoint were internal).
- Slice 4 (service-to-service call sites): `RestTemplate` (its verbs, and `exchange`/`execute` taking the method as an
  argument), the `RestClient` and `WebClient` fluent chains (the verb or `method()`, and the base URL a builder sets),
  Feign and `@HttpExchange` interfaces (one call per mapped method, the type's mapping leading the method's), URLs from
  `@Value` placeholders and `@ConfigurationProperties` accessors (prefix plus property, nested objects included), and a
  wrapper read through one level of parameter flow, its callers making the calls. A `@Value` key two profiles give
  different values is undecided, never one of them. The call sites of a repository that depends on another one given, by
  the artifact or name its build states, are read with that repository's sources: a call through a class they declare is
  read through its code, and a call through a client type whose source does not lead to a request is one
  `unresolved-link` cut naming the library. The same sources reach the listeners of that repository: a NATS listener
  whose subscription lives in a base class of the repository it depends on is found, named after the concrete class
  and placed at that class's declaration in the repository's own source; a read of one repository alone never sees
  them. On the probe workspace the seven service-to-service call sites are those
  cuts: the company's client resolves its URL from a configuration key inside an OkHttp call, outside the declared
  vocabulary, and the slice accepts the cut naming the library instead of a link. Test sources are never call sites. A
  source of the repository the grammar rejects is one call site whose `target` is `unknown` with `source-unreadable`, at
  the parser's error line (line 1 when parsing throws), under the first transport the reader reads; a library source the
  grammar rejects adds nothing.
- Slice 5 (events with destinations): a publisher is read from `KafkaTemplate.send`, `RabbitTemplate.convertAndSend`
  (the routing key: the first argument, or the second when an exchange leads), `JmsTemplate.convertAndSend` and `send`,
  `ApplicationEventPublisher.publishEvent` (the destination is the event's qualified type) and the NATS client's
  `publish`; a part the code fills at run time is one `{}` token, and a destination it does not state is unknown. A
  publish through a messenger type whose source is not given is one `unresolved-link` cut naming the library, by the
  same name heuristic the HTTP reader uses. A listener is read from the existing annotations and, for NATS, from
  `Connection.subscribe`, `JetStream.subscribe` and `Dispatcher.subscribe` (a dispatcher held in a field or created in
  place with `connection.createDispatcher()`), as `nats <subject>`, in a method or in a constructor, whose listener names
  the class. The join matches a publish to a listener of
  another repository with the same protocol and a destination that takes it, basis `event-destination` at confidence 1;
  for NATS a listener's `*` stands for one token and its `>` for one or more trailing tokens, and a token the publisher
  fills at run time for one (decision 9). A destination several listeners consume is one link per listener, whether they are
  in one repository or in several, since pub/sub delivers a message to every subscriber; queue groups are not modelled. On the probe workspace the five
  publishers are cuts naming the messenger library, whose source the workspace does not hold, and the five listeners
  extend a base class of that library, so no listener is read and no pair links: the slice accepts the cut on the
  publisher side, and the listener side stays silent until that library's source is passed as a repository.
- Slice 6, the fixpoint: the join repeats until no link is left to admit, keyed by `Link.id`, and a repository is
  walked again only when a fresh link feeds it. Upstream, the handlers a walk reached seed the next join in the
  repository that makes the call site; downstream, a change's own symbols send their call sites onward, and each
  repository a link lands in is walked once from all its call sites, keeping those whose walk reaches the fed handler.
  Every link carries its `direction` and its `reach`: the ids crossed from the change, nearest first, the shorter path
  winning when two reach one link and upstream winning a tie. Downstream runs on `ofChange` only: a `callers` answer
  asks what depends on the symbols named and has no change to send onward. The chain is a fixpoint over the finite set
  of links, never a hop count.
- Every workspace answer says where its repositories came from, in `workspace.source` of both values: `request` when the
  caller named them, `persisted` when the bound repository's manifest did, and `none` when neither did, which leaves the
  answer about the bound repository alone and says so in its text. `init --workspace` checks every repository its
  declaration names against the filesystem, at the declared revision, before it writes anything.
- `patterns` is not accepted yet: no rule consumes it before service-to-service call sites and events (slices 4 and 5),
  and a parameter nothing reads is the failure `gateways` was in slice 1. It enters with the first call pattern that
  matches something.
- A call whose literal segment fills a route's parameter links at full confidence: `GET restaurants/daily-menus` joins
  `GET /restaurants/{id}` because the syntax accepts it. ye-ast cannot know the parameter excludes that value.
