# RFC-0028: Values flow through the project's own wrappers

- Status: Accepted, 2026-11-09. Owner, 2026-11-09: "Resuelve todas las preguntas abiertas como recomiendes" (every open question settled as recommended; see Resolved questions). ADR-0050 records its decisions.
- Reproductions: kept with the study run outside the repository (`evaluations/runs/20261108T2245Z-agent-usefulness-12f8/engine-gaps/designs/rfc-0028-value-flow-through-wrappers/repro`).
- Engine: cited lines are read at `main` `d0aee793`; the reproductions in `repro/` were taken at `6d21e7bc`. The
  TypeScript pack files cited (`http-call-sites.adapter.ts`, `consumer-flow.walker.ts`, `request-origins.adapter.ts`,
  `contract-consequences-queries.ts`) are unchanged between the two; the two `consumer-sources.ts` and `compose.ts`
  citations were re-read at `d0aee793` after ADR-0045 L2 landed.
- Related: [RFC-0021](0021-java-value-flow.md) (Java method summaries), [RFC-0022](0022-contract-change-consequences.md)
  (contract consequences: flow steps, origins, P3 invariant), [RFC-0023](0023-consequences-surfaces.md),
  [ADR-0013](../adr/0013-coverage-grows-only-with-evidence.md), [ADR-0041](../adr/0041-one-call-reconciliation-for-every-family.md),
  [ADR-0042](../adr/0042-completeness-is-relative-to-the-question.md), [ADR-0044](../adr/0044-one-implementation-closure-with-scoped-vetoes.md)
  (V3, decisions 11 and 12), [ADR-0045](../adr/0045-one-assembly-line-for-the-snapshot-reading.md) (B11, B12)

**In short:** a request a function issues through the project's own wrapper is today invisible or misstated, because
the wrapper's URL is a function of its parameters and the reader only knows the parameters of the call it stands on.
Compute one **method summary** per declaration — the request shapes it can reach with one hole per parameter, and how
its return carries the response body — by a monotone fixpoint over the snapshot's own call edges, and apply it at every
call. The same rule, one implementation per language pack, replaces the ad-hoc "wrapper method" layer of the TypeScript
pack. Where a summary cannot be decided, the answer emits one named cut at the call, never a silent absence and never a
list of unrelated call sites.

## Problems

| Item | Symptom: what was asked, what ye-ast answered | Evidence (workspace) |
|---|---|---|
| `N-shopizer-X-FIELD.A1-N1`, `N-shopizer-X-FIELD.A2-N1`, `CF-shopizer-X-FIELD` | "Which admin code reads `code` of `GET /api/v1/private/product/option/{id}`?" Answer: `complete (2 undecided)`, **no consumer named**; one `unknown (unresolved)` at the service call (`via: link-basis:suffix`) and one listing nine unrelated call sites (`crud.service.ts:19-50`, `CaptchaRequestUtils.java:67`, `image-uploading-adapter.ts:36`, `connection-status.service.ts:22`). Oracle: `option.component.ts:101` and `:127`, a blocked save. | `shopizer/admin:src/app/pages/catalogue/options/services/option.service.ts:38`; `…/shared/services/crud.service.ts:18-32`; `…/options/option/option.component.ts:53-54,101,127` |
| `N-nname-X-FIELD.A2-N1`, `CF-nname-X-FIELD` | "Which frontend code reads `deliveryAddresses` of `POST /users/me/address`?" Answer: `complete (1 undecided)`, no consumer; thirteen `unknown (unresolved)` places, ten of them the generic client's own verb calls. Oracle: `user.store.ts:82-84`, `:179-183`, `address.store.ts:42-45`. | `nname/name-webapp:src/app/core/rest/services/client/rest-client.service.ts:26-34,120-125`; `…/features/user/api/user-address.api.ts:30-37`; `…/features/user/stores/user.store.ts:82-84` |
| `CF-realworld-X-FIELD` | "Which frontend code reads `createdAt` of `GET /articles/feed`?" Answer: `complete (1 undecided)`; one `unknown (unresolved)` at the service call plus the handler, no consumer. Oracle: `article-list-item.component.html:8` through `ArticlesService.query → ArticlesListStore → ArticleListComponent`. | `realworld/frontend:libs/articles/data-access/src/services/articles.service.ts:41-46`; `libs/core/http-client/src/lib/api.service.ts:17-30` |
| `N-JHIPSTER-X-FIELD.A1-N1`, `N-JHIPSTER-X-FIELD.A2-N1`, `CF-JHIPSTER-X-FIELD` | "Which frontend code reads `authorities` of `GET /api/account`?" Answer: `complete (2 undecided)`; one correct `use incompatible` at `account.service.ts:44` (reported as "reads (whole body)"), two groups of unresolved places at `account.service.ts:73,49,65`, `settings.ts:46,48`, `login.service.ts:13`. **Missing with no cut**: `has-any-authority.directive.ts:28` (`currentAccount()?.authorities`) and the `authorities` form control (`settings.ts:37,48,56`). | `jhipster/application:src/main/webapp/app/core/auth/account.service.ts:15,17,30,37,44,49-51,73`; `…/shared/auth/has-any-authority.directive.ts:23-28`; `…/account/settings/settings.ts:37,46-48,56` |

Nine items in all (five graded needs, four counterfactual calls). Zero of them is answered with a consumer.

## Root cause

Two mechanisms. Both are mechanisms in the engine; neither is "the repository is unusual".

### M1 — the request a wrapper makes is read only where it is written, never where it is called (confirmed)

The TypeScript pack decides a call site from the **arguments of the call it stands on**, and models a project wrapper
only as far as a single class that owns an `HttpClient` field forwards its own parameter *as the tail of the URL*:

- `src/core/adapters/typescript/http-call-sites.adapter.ts:197-255` (`wrapperMethods`, `injectedClasses`,
  `reachingMethods`) seeds the wrapper set from classes that own an `HttpClient` field (`httpFields.size === 0` returns
  an empty set at `:231`), so a second layer (a service that calls `CrudService`, `RestClientService`, `ApiService`)
  is never a wrapper.
- `:345-368` (`forwardsAsTail`) accepts only a URL that *ends* with the parameter, so a wrapper that builds its URL in
  a helper (`resolveUrl(path, options)`) forwards nothing: `HttpClient` verb call at
  `rest-client.service.ts:34` is not a wrapper leaf.
- `:584-589` (`forwardsItsOwnParameter`) drops the wrapper's own verb call as a call site, so a class that *is* a
  wrapper contributes no site at its own body and no site at its callers unless the caller class owns a client too.
- `:662-672` (`request`) evaluates `call.arguments[0]` in the **caller's** scope and starts from `callUrl(path)`: the
  wrapper's own prefix text (`${this.url}`, `${this.api_url}`, `${base}`) never enters the target. The path it states
  is therefore only the argument.

Reproduced on `main` `6d21e7bc` (`repro/plan-shopizer*.json`, Node 24.22.2, own state dir):

```
status: complete (2 undecided)
  1. GET /api/v1/private/product/option/{id} response code {"renamed":"renamedField"}: complete (2 undecided)
    - unknown (unresolved) at admin:…/options/services/option.service.ts:38
    - unknown (unresolved) at backend:…/utils/CaptchaRequestUtils.java:67, admin:…/image-uploading-adapter.ts:36,
      admin:…/connection-status.service.ts:22, admin:…/crud.service.ts:19, :22, :25, :28, :39, :50
```

`repro/answer-shopizer-full.json` carries the reason of the first finding: `via: link-basis:suffix`. The call at
`option.service.ts:38` passes `/v1/private/product/option/${id}`; the wrapper's field `url` is
`environment.apiUrl = "http://localhost:8080/api"` (`admin/src/environments/environment.ts:21`), which the summary would
have folded, and the route is `/api/v1/private/product/option/{id}` (`ProductAttributeOptionApi.java:49,59`). Without the folded base the call matches the route
only by **suffix**, `QUALIFIED_BASES` (`src/core/application/contracts/contract-consequences-queries.ts:23`) excludes
`suffix`, and the value is reported as a cut instead of followed.

The same reproduction shows the noise: the wrapper's own verb calls (`crud.service.ts:19-50`) are reported as
unresolved call sites because their URL is `${this.url}${path}`, i.e. a run-time hole (`{}`) that follows text in the
same segment (`src/core/adapters/typescript/http-call-sites.adapter.ts:1357-1362`, `startsSegments`), and
`src/core/application/contracts/contract-consequences-queries.ts:147` turns *every* unresolved site of the workspace
into one finding of every answer.

`repro/plan-realworld.json` shows the second face of M1 — an argument the reader cannot evaluate at all
(`'/articles' + (config.type === 'FEED' ? '/feed' : '')`, a conditional expression the evaluator does not read,
`:729-757`): the call is `unknown (unresolved)` and the operation keeps no consumer. `repro/plan-nname.json` shows the
third — `RestClientService.get` builds its URL through `resolveUrl` (`rest-client.service.ts:120-125`), whose return
reads its own parameters (`evaluateMethod` refuses it at `:996-1015`, `readsOwnParameters`), so all ten verb calls stay
unresolved and the two calls above them are not sites at all.

### M2 — the response value is started from the callee's *name*, and holders between calls drop it silently (confirmed)

- `src/core/adapters/typescript/consumer-flow.walker.ts:1005-1011` (`requestKind`) decides that a call returns an HTTP
  body when the callee is **named** `get|post|put|patch|delete|head|options|request|fetch|httpResource`, whatever its
  receiver and declaration. A wrapper named otherwise (`identity`, `query`, `createAddress`, `replaceWith`) is a silent
  stop: `:135-137` returns `lostAt(…, "no call at the reported site")` only when no call is found, and finds none of
  these. `:135` also requires `symbolOf(call) === site.symbol`, so a call inside a nested arrow is only found when its
  symbol matches.
- A value bound to a **holder** the flow has no row for ends silently or as a frontier, not as a use:
  `account.service.ts:17` (`readonly account = this.userIdentity.asReadonly()`) never receives `userIdentity`'s value,
  so `has-any-authority.directive.ts:28` (`currentAccount()?.authorities`) is never a carrier and appears in **no**
  finding and **no** cut; `settings.ts:48` (`patchValue(account)`) and `:56` (`getRawValue()`) are not rows either.

Reproduced on `main` `6d21e7bc` (`repro/plan-jhipster.json`):

```
- unknown (unresolved) at …/account.service.ts:73, :49, :65, …/settings.ts:46, :48
- use incompatible at …/account.service.ts:44; reads (whole body), changed (whole body); witness undefined
- unknown (unresolved) at …/account.service.ts:73, :49, :65, …/login/login.service.ts:13
```

The directive line and the form control are absent; RFC-0022 P3's invariant ("a carrier ends in a use, a next carrier,
or a frontier") is violated, which is what the study reports as "status `complete` while the read is unknown".

## Reach

Broad form searched over the whole `src/`: `forwardsAsTail`, `forwardsItsOwnParameter`, `FORWARDING_CALLS`,
`wrapperMethods`, `reachingMethods`, `injectedClasses`, `requestBody`, `requestKind`, `startsSegments`. The same M1
mechanism lives at every one of those places; the variants it produces beyond the observed cases:

| Variant | Why it fails today | Corpus witness |
|---|---|---|
| a wrapper whose method is not named like a verb | `wrapperMethods` keeps only names in `VERBS` (`:249`) | `nname:address.store.ts:42` → `createAddress`; `rest-client.service.ts:20-26` |
| three layers (component → feature service → generic client) | the wrapper set is seeded from `HttpClient` owners only | `nname:user-address.api.ts:32` → `rest-client.service.ts:44`; `shopizer:option.service.ts:38` → `crud.service.ts:30` |
| a wrapper that builds its URL in a helper | `forwardsAsTail` needs the parameter at the tail; `evaluateMethod` refuses a method that reads its parameters | `nname:rest-client.service.ts:120-125` |
| an overloaded wrapper | `memberDeclaration` returns the first member of the name, an overload signature with no body (`consumer-flow.classes.ts:51-58`) | `nname:rest-client.service.ts:37-48,81-92` |
| a conditional or `??` in the URL | `evaluate` has no branch for `ConditionalExpression` | `realworld:articles.service.ts:43` |
| the request inside a callback (`defer`, `from`) | the leaf's enclosing method is not a wrapper, and the chain stops at the callback | `nname:user-address.api.ts:31-37` |
| a wrapper that projects the body (`map(r => r.data)`) | no summary; the site either is absent or starts at the unprojected body | none in this corpus, variant of the rule |
| a response bound to a derived holder (`asReadonly`, `computed`, a form control, `resource.set`) | M2 has no holder row | `jhipster:account.service.ts:17`, `has-any-authority.directive.ts:27`, `settings.ts:48`; `nname:user.store.ts:82-88,177-184` |

## Design

### Place on the assembly line

One new **domain contract** (`core/domain/topology/`) and two pack readings:

- **B11 call sites** (TypeScript pack, `core/adapters/typescript/http-call-sites.adapter.ts`) gains the summary and
  applies it at every call. This replaces `wrapperMethods`, `injectedClasses`, `reachingMethods`, `forwardedVerb`,
  `forwardsAsTail`, `FORWARDING_CALLS` and `forwardsItsOwnParameter`.
- **B12 TypeScript value-flow program** (the consumer-flow walker) starts a value from the summary's result shape, and
  gains a holder table.
- The Java pack keeps RFC-0021's own summary types and is untouched (see "Java: what ADR-0044 V3 closes and what
  remains" for why no Java unit is needed).

It extends RFC-0021 S1 from "the Spring HTTP and event readers" to a language-agnostic contract, and implements
RFC-0022 P5's "a call through a wrapper method (the P1.5 fixpoint)" as the one rule both directions of flow use. It
contradicts no accepted ADR: ADR-0042 is satisfied by the cut table below (section "Which cut, exactly"), and ADR-0044
V3's principle — *a veto is released only by positive proof* — is adopted for TypeScript as "several candidate
declarations whose shapes disagree are a cut, never a merge".

### Contract: `src/core/domain/topology/request-summary.ts`

```ts
import type { Evidence } from "../shared/fact.ts";
import type { HttpMethod } from "../entrypoints/http-route.ts";
import type { CallSiteDiagnostic } from "./call-site.ts";

/** Why a summary could not be decided. The closed set is the call-site one, so no enum and no SCHEMA changes. */
export type SummaryCause = Extract<
  CallSiteDiagnostic["cause"],
  "recursive" | "dispatch-disagreement" | "destination-undecidable" | "source-not-read"
>;

/** Which of the function's own parameters supplies the request body. */
export type BodySource =
  | { kind: "parameter"; index: number }
  | { kind: "none" }
  | { kind: "unknown"; index: number };

/** A run-time choice inside the path the code writes: a condition on one of the function's own parameters. */
export interface PathCondition {
  parameter: number;
  test: "truthy" | "falsy";
}

/**
 * One request a function can make, stated over its own parameters: `path` is the whole URL the leaf writes — the
 * function's own text, consts and fields folded — with `{}` where one of the function's parameters is read, in source
 * order. A hole is not a cut: it is a value the call supplies.
 */
export interface RequestShape {
  transport: "http" | "event";
  /** Undefined when the verb is a value an argument fills. */
  method: HttpMethod | undefined;
  path: string;
  body: BodySource;
  /** Present when the shape holds only under this test of the parameter; several shapes of one leaf split by a conditional. */
  when?: PathCondition;
  /** The request-writing calls this shape passes through inside the function, nearest last. */
  hops: readonly { function: Evidence; call: Evidence; forwarded: Evidence }[];
}

/** How the function's return carries a response body. */
export type ResultShape =
  | { kind: "none" }
  | {
      kind: "body";
      container: "plain" | "observable" | "promise" | "resource";
      /** `response` when the request is observed with `observe: 'response'`, so the body sits under `body`. */
      observed: "body" | "response";
      /** The access path a projection maps the body to, when the function returns one mapped value. */
      projection?: readonly string[];
    }
  | { kind: "unknown"; cause: SummaryCause; evidence: readonly Evidence[] };

export interface SummaryGap {
  cause: SummaryCause;
  /** Where the undecided reading is: the declaration, the call, the argument. */
  evidence: readonly Evidence[];
}

/**
 * One call that hands a value on without being a declaration of its own (a framework function, never a snapshot type):
 * where the carried expression sits, which parameters the callback receives, and what the call returns.
 */
export interface ForwardingRow {
  /** The callee's name: `defer`, `from`, `firstValueFrom`, `asReadonly`, `computed`, `signal`, `resource`, `linkedSignal`. */
  name: string;
  /** Where the declaration's own expression sits in the call: an argument index, or the receiver for a no-argument member. */
  carries: { kind: "argument"; index: number } | { kind: "receiver" };
  /** The parameters a carried callback receives, by index: `carries` names the callback, these name what it is called with. */
  callback?: readonly { index: number; from: { kind: "result" } | { kind: "receiver" } }[];
  /** What the call itself returns: the carried value unchanged, or the carried value in a container. */
  returns: { kind: "same" } | { kind: "container"; container: "observable" | "promise" | "resource" | "signal" };
}

/**
 * What one declaration does with its parameters and its return. `shapes` empty and `gaps` empty is a proof that the
 * body issues no request of the pack's vocabulary; `undefined` from the lookup means "not a snapshot declaration".
 */
export interface RequestSummary {
  shapes: readonly RequestShape[];
  result: ResultShape;
  gaps: readonly SummaryGap[];
}
```

No other type changes. `CallSite`, `HttpTarget`, `CallSiteDiagnostic`, `CALL_SITE_CAUSES`, `FlowFrontier` and
`FRONTIER_CAUSES` stay as they are.

### Algorithm (TypeScript pack, `src/core/adapters/typescript/request-summaries.ts`)

One computation per read hold: `summariesOf(files)` memoizes in a `WeakMap` keyed by the `files` array's identity (one
read allocates one array), and the value is a `Promise`, so the B12 rule holds — rebuilt in the next read, never a cache
entry, and S1 needs no edit in `http-call-sites.adapter.ts` to own it.

1. **Declarations.** Every top-level function, and every class method or property initialized with a function, of the
   snapshot, keyed `file\0` + the declaration's `Class.member` (or its own name at the top level) — the file is part of
   the key, since `symbolOf` returns `Class.member` alone (`http-call-sites.adapter.ts:1426-1441`). Declarations sharing a
   name in one class are one key: its body is the unique member with a body; zero or two bodies is
   `gaps: [{cause: "dispatch-disagreement"}]` with every signature as evidence.
2. **Leaves.** Walk a declaration's body without entering nested functions (they are declarations of their own). A call
   is a leaf when its callee is in the pack's client vocabulary — Angular `HttpClient` by import, `fetch`,
   `httpResource`, or a client a declared library source names (the same rule as today, `:20,288-304`). The shape's
   `path` is `evaluate` of the path argument **in the declaration's own scope**, so `this.url`, a const import and an
   `environment` object member fold to text and a parameter becomes `{}` wherever it sits (`${this.url}${path}` is
   `http://localhost:8080/api{}`). `method` is the verb, or the `method` argument when it is a value. `body` is
   `{kind: "parameter", index}` when the body argument is one of the declaration's own parameters, `none` for a
   literal, `unknown` otherwise.
3. **Edges.** A call whose callee resolves to another declaration is an edge, with its argument expressions. A call
   that resolves to nothing contributes neither a shape nor a gap: the pack cannot claim that an unread callee issues
   a request, and the operation-level `no-call-site` finding already covers it.
4. **Forwarding calls.** The closed table `FORWARDING_ROWS: readonly ForwardingRow[]` (the contract's type) has one row
   per construct: `defer` (carries argument 0, a callback run later, returns a container `observable`), `from` (argument
   0, container `observable`), `firstValueFrom` (argument 0, returns the carried value), `signal` (argument 0, returns a
   container `signal`), `computed` (argument 0, a callback with no parameters, returns a container `signal`),
   `asReadonly` (receiver, returns the same value), `resource` (argument 0, an options object whose `loader`/`stream` is
   argument 0 of that member, returns a container `resource`), `linkedSignal` (argument 0, returns a container `signal`).
   A call whose callee resolves to no declaration and matches no row contributes nothing (step 3's reason). A row whose
   carried position is not what the code writes contributes a gap `destination-undecidable` at that call — never
   silence, and never a guess at another argument.
5. **Conditional split.** A path expression that is a `ConditionalExpression` whose test reads one of the declaration's
   own parameters splits into two shapes, one per branch, each carrying `when: {parameter, test: "truthy" | "falsy"}`.
   A `??`/`||` on a parameter splits the left shape as `truthy` and the right as `falsy`. Any other conditional, and a
   conditional nested in a branch, is a gap `destination-undecidable` with both branch places as evidence. This is the
   one place branch splitting exists; `evaluate` in the adapter keeps no branch handling.
6. **Fixpoint.** `shapes(f) = leaves(f) ∪ ⋃_{(g,args)} substitute(shapes(g), args)` and `gaps(f)` likewise, iterated to
   a fixpoint over the finite set of declaration keys, growing monotonically. A declaration met on its own substitution
   path contributes `{cause: "recursive"}` with its place and is not entered again (RFC-0021 S1, no depth cap).
7. **Substitution.** For a shape `s` of `g` reached by the call `c` with arguments `a₁…aₙ`: evaluate each `aᵢ` in
   `c`'s scope; replace `s`'s holes in source order with the written text (a run-time value keeps `{}`). `method`
   undefined maps from an argument that states a verb, else the shape becomes a gap `destination-undecidable`.
   `body` maps `{kind:"parameter", index:i}` to the caller's own parameter when `aᵢ` is one, else to `none`/`unknown`.
   A `when` test on parameter `i` is decided against `aᵢ` (`""`, `0`, `false`, `null`, `undefined` are falsy; a non-empty
   literal is truthy): a decided condition keeps the surviving branch only, and an undecided one keeps both shapes, each
   still carrying its `when` rewritten onto `c`'s own parameter when `aᵢ` is one (a residual conditional of the caller).
   `hops` gain `{function: c's declaration, call: c, forwarded: the leaf's call}`.
8. **Result.** Read every `return` of the declaration without entering nested functions:
   - a leaf → `{body, container: observable|resource|promise|plain, observed}`;
   - a call to a declaration with a result → that result, its container composed (a wrapper returning a wrapper's
     observable stays `observable`);
   - `x.pipe(map(fn))`, `map(fn)` over a body → `body` with `projection` when `fn` returns an access path of its
     parameter, else `{kind: "unknown", cause: "destination-undecidable"}`;
   - a call matching a `ForwardingRow` whose `returns.container` is a container → that container over the outcome of its
     carried position (`defer(() => expr)` → the result of `expr`, container `observable`);
   - anything else → `none`;
   - returns that disagree → `{kind: "unknown", cause: "dispatch-disagreement"}`;
   - a body that could not be read → `{kind: "unknown", cause: "source-not-read"}` (never `none`).
9. **Determinism.** Shapes sorted by transport, method, then path, then `when`; hops in source order; gaps by their first
   evidence `(path, line)`; every path repository-relative. Same snapshot, same bytes.

### Applying the summary: two rules, two boundaries

The class of failure has two boundaries and they are separate rules, in separate files, with separate tests.

**R1 — the call boundary (request side, `http-call-sites.adapter.ts`).** At a call whose callee resolves to a
declaration with a summary:

- `shapes` non-empty, `gaps` empty, one agreed substituted shape → the call site's target is that `HttpTarget`. The
  site's `evidence` is the call place followed by the shape's hop places, so the answer can name the client line.
- two or more shapes that remain only because a `when` the arguments did not decide → `target: unknown`, cause
  `destination-undecidable`, `alternatives` = their paths, evidence = the call and every leaf. A run-time choice is an
  alternative, never a disagreement.
- two or more shapes that differ with no `when` → `target: {status: "unknown"}`,
  `diagnostic: {cause: "dispatch-disagreement", alternatives: <canonical shapes>}`, evidence = the call and every leaf.
- `gaps` non-empty → `target: {status: "unknown", reason: "unresolved"}` with the prevailing gap cause, `stated` set to
  the one stated shape when there is one, evidence = the call and the gap places. **Fail closed**: a call that may also
  reach a request the summary could not state is not attributed confidently; the answer names the gap at that call.
- `shapes` empty and `gaps` empty → no call site (the body was read and issues no request).
- no summary (not a snapshot declaration) → no call site; the operation's `no-call-site` finding remains the answer.

**Site placement.** A shape that states no hole is sited at its **leaf**. A shape that states a hole is sited at the
**nearest call outward from the leaf that supplies one of its holes**, and no caller further out is a site for that
shape, so one shape yields exactly one site. That is today's `forwardsItsOwnParameter` ("the URL ends with the
declaration's parameter") generalized to "the shape states a hole anywhere". It keeps `jhipster`'s chain (its `get`
states no hole, so the site stays at `account.service.ts:73`) and moves `shopizer`'s (a hole, supplied one level above
the leaf, at `option.service.ts:38`). `startsSegments` moves from leaf reading to **substitution**: a hole is refused
only when the value that replaced it is a run-time value that follows text in the same segment — which is why
`${this.url}${path}` is legal at the call (`/api` + `/v1/…`) and why the leaf's own `http://…/api{}` is not a target on
its own.

**R2 — the holder boundary (response side, `consumer-flow.walker.ts` + `consumer-flow.holders.ts`).** A holder is a
construct that binds the carried value and hands it back through a read. The pack holds one table,
`HOLDER_ROWS: readonly HolderRow[]`, and the walker reads it in the one place that decides a call on a carried value
(`read`'s `methodCall`, `:404-427`):

```ts
/** One construct that binds a carried value and hands it back through a read. */
export interface HolderRow {
  /** The callee's name as the code writes it: `signal`, `set`, `computed`, `asReadonly`, `linkedSignal`, `resource`, `value`, `patchValue`, `setValue`, `reset`, `getRawValue`. */
  name: string;
  /** Where the carried value sits in the binding call. */
  binds: { kind: "argument"; index: number } | { kind: "receiver" };
  /** What a read of the holder hands back: the whole value, the value under this member, or every control the value names. */
  read: { kind: "same" } | { kind: "member"; name: string } | { kind: "controls" };
}
```

| Row | `binds` | A read hands back |
|---|---|---|
| `signal(v)`, `signal.set(v)` | argument 0 | the whole value (`h()`, `h.asReadonly()`) |
| `computed(() => expr)` | argument 0, the callback's body | the whole value (`h()`) |
| `asReadonly()` | receiver | the whole value (`h()`) |
| `linkedSignal(...)` | argument 0 | the whole value (`h()`) |
| `resource(opts)` | argument 0, its `loader`/`stream` result | the value under `value` (`r.value()`) |
| `patchValue(v)`, `setValue(v)`, `reset(v)` | argument 0 | every control the value names (`getRawValue()`, `value`, `controls[x]`): `controls` |

A zero-argument call of the holder (`h()`) is a read; a member read `h.value` of a `resource` maps the trail under
`value`. A call on a value held by a construct outside the table is a frontier `unmodelled-sink`,
`detail: "holder:<name>"` — never silence. No carrier kind is added: a holder read reuses `member`/`member-read`.

### One owner for "is this call a request"

One function answers "is this call a request of the project" for the TypeScript pack, and every reader calls it. Its
rule lives in one module, `src/core/adapters/typescript/request-summaries.ts`; the function is
`createRequestCallLookup`, exported from the B11 stage `src/core/adapters/typescript/http-call-sites.adapter.ts` because
that stage owns the pack's one URL evaluator. There is no other predicate: `VERBS.has(name)`, `fetch` and `httpResource`
are the *client vocabulary of a leaf*, read inside the rule module, never a test any other file applies.

The adapter already owns the one URL evaluator and exports the two seams the flow readers use (`createRequestBodies` at
`:141`, `VERBS` at `:19`), so the lookup is created there, from `readerOf(files)`, with no second evaluator and no new
port.

```ts
// request-summaries.ts — the rule. No consumer imports this directly except the B11 stage and its test.
export type DeclarationKey = string; // `file\0` + `Class.member`, or the function's own name at the top level

/** What the rule needs from the pack's one URL evaluator: the B11 reader supplies it. `SummaryCause` is the domain's. */
export interface SummaryResolver {
  /** What an expression states in a declaration's scope: text with `{}` for a run-time value, or why not. */
  evaluate(file: string, expression: ts.Expression): Promise<
    | { status: "known"; text: string }
    | { status: "undecided"; cause: SummaryCause; evidence: readonly Evidence[] }
  >;
  /** The declaration a call resolves to, or undefined when it is not a snapshot declaration. */
  calleeOf(file: string, call: ts.CallExpression): Promise<{ key: DeclarationKey; file: string; body: ts.Node | undefined } | undefined>;
}

/** Every summary of one read, by declaration key. Memoized by the `files` array and `resolver` identity: one read. */
export function summariesOf(files: readonly SourceFile[], resolver: SummaryResolver): Promise<ReadonlyMap<DeclarationKey, RequestSummary>>;

export interface RequestCallLookup {
  /** The request call a placed site states, at its line and, when it has one, its column (ADR-0044 decision 7). */
  at(site: { file: string; line: number; column?: number; symbol: string }): ts.CallExpression | undefined;
  /** Whether this call issues a request of the project: a client leaf, or a callee whose summary states a shape. */
  isRequest(call: ts.CallExpression): boolean;
  /** The summary of the declaration the call resolves to; undefined when it is not a snapshot declaration. */
  of(call: ts.CallExpression): RequestSummary | undefined;
}

// http-call-sites.adapter.ts — the one owner every reader calls.
export function createRequestCallLookup(files: readonly SourceFile[]): RequestCallLookup;
```

`at` keeps ADR-0044 V5.2's exact contract, so the brief calls this factory without retyping anything. The two
consumers hold the lookup for their reader's life (one `Promise` per `files` array), exactly as `createRequestBodies`
already is (`request-origins.adapter.ts:18-19`).

| Copy of the predicate | Where | Deleted by | What replaces it |
|---|---|---|---|
| `namesRequest` | `request-origins.adapter.ts:62-66`, used at `:26` | **S2** | `createRequestCallLookup(files).at(site)` in `ofBody` |
| `requestKind` | `consumer-flow.walker.ts:1005-1011`, used at `:136` | **S3** | `createRequestCallLookup(files).at(site)` in `startCallSite`; `startCallResult` (`:147-156`) keeps its own column logic, because a call result is not a request |
| ADR-0044 V5.2's `createRequestCallLookup` | `briefs-adr-0044/units.md` V5.2, steps 1-2 | **S2** | this factory; V5.2 keeps its column-first fallback (step 2) and its deletions (step 3), and its predicate body (step 1) moves here |

`VERBS` stays exported as the vocabulary `request-summaries.ts` reads. **S2 adds the one-owner row to
`src/composition/assembly-line.fitness.test.ts`** as a shrinking list, `REQUEST_VOCABULARY_IMPORTERS`, seeded with the
two copies (`request-origins.adapter.ts`, `consumer-flow.walker.ts`); S2 removes its own entry, S3 the other, and the
test then asserts that the only importer of `VERBS` is `request-summaries.ts`. The brief's open question 1 is answered
this way. `startCallResult` is unchanged. The Java pack's own leaves (`spring/java-call-sites.adapter.ts`) are another
pack and are untouched.
**Ordering:** if ADR-0044 V5.2 lands before S2, S2 replaces its predicate body and keeps the exported name and
signature; if V5.2 lands after, V5.2 shrinks to column location and the deletions. One owner at every point in the
sequence.

### Which cut, exactly

| Situation | Where | What the answer states |
|---|---|---|
| the callee is not a snapshot declaration | call | no site; the operation's `no-call-site` finding (existing, unchanged) |
| the summary proves the body issues no request | call | no site; nothing to state (a proof, not a silence) |
| one agreed shape | call | a link, basis by the ladder |
| candidate declarations disagree | call | `unknown (unresolved)`, cause `dispatch-disagreement`, `alternatives` = the canonical shapes, evidence = the call and each leaf |
| the shape is on its own substitution path | call | `unknown (unresolved)`, cause `recursive`, evidence = the declaration and the call |
| a declaration's body could not be read | call | `unknown (unresolved)`, cause `source-not-read`, `unreadableSources` |
| an argument leaves the verb, or the path, unnamed | call | `unknown (unresolved)`, cause `destination-undecidable`, `stated` = the stated request |
| the summary is decided, its result unknown | flow | one frontier at the call, `cause: "unmodelled-flow"`, `detail: "request-summary"`, chain = the hops |
| the summary is decided, result `none` and the hypothesis names a property | flow | one frontier, `detail: "request-summary:no-body"` |
| a construct that holds the value is outside the holder table | flow | one frontier, `cause: "unmodelled-sink"`, `detail: "holder:<name>"` |

No new `CALL_SITE_CAUSES` value, no new `FRONTIER_CAUSES` value, no `SCHEMA` bump, so `mcp/presentation.ts`'s label
map (`:18`) and the cut schemas do not change. Every place with no row above is either a proven absence or a defect.

### Java: what ADR-0044 V3 closes and what remains

The parameter direction already exists for Java and is not redesigned here:

- RFC-0021 S1 is implemented in `src/core/adapters/spring/java-method-flow.ts`: `JavaMethodFlow`'s constructor
  (`:156-199`) builds `leaves`/`edges`/`reachable` to a monotone fixpoint, `bindMethod` (`:140-153`) binds a callee's
  parameters to the arguments of the call, and `expand` (`:205-264`) substitutes along the chain with cycle detection
  (`:239`) and a per-context memo (`:242`). That is exactly the rule this RFC states for TypeScript.
- **ADR-0044 V3 (decisions 11 and 12) closes the binding side of that Java summary**: from V3 `methodsOf` (`:73-109`)
  returns only a proven closure, the staging form that keeps today's lenient candidates is deleted (ADR-0044 decision 1,
  staging paragraph), and a call whose binding is unproven becomes the frontier cause `dispatch-not-proven` instead of a
  propagation through a guessed body. Before V3, `expand` aggregates whatever `methodsOf` answers, including `unproven`
  candidates from `java-receiver-methods.ts`; after it, a summary is aggregated only from proven bodies.
- **V3 does not need to cover `RequestSummary`/`ResultShape`, because no Java reader consumes them, and this RFC adds
  none.** `RequestSummary` and `ResultShape` are this RFC's types, introduced for the TypeScript pack; the Java pack
  keeps RFC-0021's own types (`MethodSelection`, and its `reachable` leaf sets in `java-method-flow.ts`).
  The evidence that nothing in Java would read the shared contract today:
  - the response direction (`ResultShape`) has one consumer, `consequencesOf`
    (`src/core/application/contracts/contract-consequences-queries.ts:159`), fed by `session.flow`
    (`consumer-sources.ts:164`), which composition wires to the TypeScript reader alone
    (`src/composition/consumer-queries.ts:8,29`: `createConsumerFlowReader` for `flow` and `createRequestOriginReader`
    for `origins`). There is no Java `ConsumerFlowReader` or `RequestOriginReader` in `src/composition/`;
  - the request direction in Java is read by the Java call-site and payload readers (`spring/http-call-sites.adapter.ts`,
    RFC-0021), which do not go through `ConsumerSourcesDeps` at all.
  A Java unit that mapped `JavaMethodFlow` onto `RequestSummary` would produce a value with no reader — the placement
  rule's "does nothing reach it?" — so it is not designed here.
- **The remainder for Java is therefore empty for this RFC's scope**: beyond V3 there is no Java work in the parameter
  direction, and the return direction does not exist in Java (RFC-0022 P4, "Out of P4: Java code that consumes another
  service's responses"). The day a Java `ResultShape` gains a consumer, it is one unit that maps
  `JavaMethodFlow.expand`'s leaves onto `ResultShape {kind: "body", container: "plain"}`, with its own evidence and its
  own RFC.

This RFC does not weaken V3, and it does not claim Java adopts its contract. It applies V3's principle to TypeScript:
an ambiguous candidate set is a cut, never a merge.

### What does not change

Answer shapes (MCP text, `result JSON`, the facts schemas); the join's ladder and `QUALIFIED_BASES`; `HttpTarget`,
`CallSite`, `UnresolvedCallSite`; `consumer-flow.ts`'s carriers and `FLOW_STEPS`; the request-origin walker's backward
reading and its `Origin` vocabulary (`request-origins.walker.ts` keeps its frames; the summary hands
`createRequestBodies` the same three places `WrapperCall` already carries: the function, the call and the forwarded
call); every other family; the mode/size policy.

## Delivery units

| # | Unit | Prereqs | Files | Est. lines |
|---|---|---|---|---|
| S1 | The summary contract, the rule and its computation | — | `core/domain/topology/request-summary.ts` (new), `core/adapters/typescript/request-summaries.ts` (new), tests | ~380 |
| S2 | R1 and the one request owner: the call site is the summary applied at the call, `createRequestCallLookup` exported, the ad-hoc wrapper layer and `namesRequest` deleted | S1 | `core/adapters/typescript/http-call-sites.adapter.ts`, `core/adapters/typescript/request-origins.adapter.ts`, their tests, `src/composition/assembly-line.fitness.test.ts` | ~380 |
| S3 | R2a: the flow starts from the summary's result shape, `requestKind` deleted | S1, S2 | `core/adapters/typescript/consumer-flow.walker.ts`, `consumer-flow.adapter.ts`, tests | ~200 |
| S4 | R2b: the holder table | S3 | `core/adapters/typescript/consumer-flow.holders.ts` (new), `consumer-flow.walker.ts`, test | ~300 |

Each unit lands with `npm run check` green and a corpus-gate line in the commit that brings it to `main`. Feature branch
`feat/request-summaries`; work-unit commits, tests and docs with the behavior.

### S1 — the summary contract and its computation

*Prerequisites:* none (RFC-0021 and ADR-0044 V3 are accepted; V3 is not a prerequisite of this unit, only of the Java
statement).

*Files:* create `src/core/domain/topology/request-summary.ts` and
`src/core/adapters/typescript/request-summaries.ts` plus `request-summaries.test.ts`. Edit nothing else. Do not touch
`http-call-sites.adapter.ts`, `consumer-flow.*` or the domain files it imports.

*RED test:* `src/core/adapters/typescript/request-summaries.test.ts`, test `substitutes a wrapper's parameter into its
callee's path and keeps the prefix`. Fixture under `os.tmpdir()`: `crud.ts` with
`class Crud { constructor(private http: HttpClient) {} get(path) { return this.http.get(`${this.url}${path}`); } }` and
`svc.ts` with `class Svc { constructor(private crud: Crud) {} item(id) { return this.crud.get(`/v1/items/${id}`); } }`.
The `SummaryResolver` is a fake (the ports-and-fakes rule; folding is the adapter's, tested in S2): it answers
`H/api{}` for the `Crud.get` path expression, `/v1/items/{}` for `Svc.item`'s argument, and `undecided` otherwise.
Assert `summariesOf(files, resolver)` returns, for `svc.ts\0Svc.item`, one shape whose `path` is `H/api/v1/items/{}` and
one hop (`function` = `Svc.item`'s declaration, `call` = the `crud.get` call, `forwarded` = the `http.get` call); and
that `crud.ts\0Crud.get` states `H/api{}` with no hop and `body: {kind:"none"}`. Fails today because there is no such
module (the rule does not exist).
*Variants beyond the observed case:* (a) a wrapper that forwards through a helper returning its own parameter
(`resolveUrl(path, options) { return `${this.base}/${path}` }`) summaries the same way, and an overloaded wrapper
(`get(a); get(a, b); get(a?, b?) { … }`) yields one shape, not none; (b) a conditional path
(`return this.http.get('/items' + (all ? '' : '/' + id))`) yields two shapes, the first with `when: {parameter: 0,
test: "truthy"}` and `path: "/items"`, the second with `test: "falsy"` and `path: "/items/{}"`; substituting with the
literal `''` keeps only the second, and substituting with an undecided argument keeps both.

*GREEN acceptance:* the tests pass; a fixture with a cycle (`a()` calls `b()`, `b()` calls `a()`) and a request in `b`
yields one shape and one `recursive` gap. Real probe: `repro/plan-shopizer.json` still answers as today (no consumer),
because S1 wires nothing.

*Corpus gate:* `none` — no reader consumes the module yet; answers are byte-identical.

*Docs:* RFC-0021 gains a line in "Related" pointing here; RFC-0022's flow-step table gains the conditional split; no
README row yet.

*Risk:* item 3 (a contract others consume) — the new *domain* file and module are internal and unreferenced, so no;
item 6 (no test catches it) — the RED tests and the two variants above. **Risk: none.**

*High-risk item:* none.

### S2 — the call site is the summary applied at the call

*Prerequisites:* S1. The overload collapse of the binder's T5 unit is **not** a prerequisite: step 1 of the algorithm
decides the body itself, and `memberDeclaration`'s first-match behaviour is only read for the class's members.

*Files:* edit `src/core/adapters/typescript/http-call-sites.adapter.ts` and its test, and
`src/core/adapters/typescript/request-origins.adapter.ts` and its test; edit
`src/composition/assembly-line.fitness.test.ts` to add `REQUEST_VOCABULARY_IMPORTERS` (seeded with the two copies) and
remove `request-origins.adapter.ts` from it. Specifically, in the call-site adapter:
export `createRequestCallLookup` (the owner), implement `SummaryResolver` over the existing `Reader` (three small
methods: the evaluator the adapter already has, the callee resolution it already has, and the file shape), rewrite
`readPlaced`/`callSite` without the `includeForwarding` flag, and rewrite `requestBody` to read the summary's `hops`
instead of `FORWARDING_CALLS`; the rule keeps, beside the domain `RequestShape`, an adapter-internal chain of those hops as
`ts` nodes, which is what `RequestBody.wrappers` is filled from. A public signature changes in none of `of`, `placed`,
`requestBody` or the `CallSite` types. **`placed` after the change:** it answers every site with its exact place and, for every site, `origins` = the
summary's hop places (the client line inside the wrapper), where today only a forwarding site carries them; the trace
caller `src/core/application/trace/trace-queries.ts:169` and its wiring `src/composition/compose.ts:175-180` read the
same port signature and need no edit. In the origin reader: delete `namesRequest` (`:62-66`) and use
`createRequestCallLookup(files).at(site)` at `:26`. Remove `wrapperMethods`, `injectedClasses`, `reachingMethods`,
`thisCalls`, `forwardedVerb`, `forwardsAsTail`, `parametersOf`, `FORWARDING_CALLS`, `forwardsItsOwnParameter`. Do not
touch `consumer-flow.*`, the domain files, the CLI or the MCP.

*RED tests:* (a) `http-call-sites.adapter.test.ts`, test `a request made through a project wrapper is a site at the call,
with the wrapper's base`. Fixture under `os.tmpdir()`: `environment.ts` exporting `{ apiUrl: "http://h/api" }`,
`crud.ts` with `class Crud { url = environment.apiUrl; constructor(private http: HttpClient) {} get(path) { return
this.http.get(`${this.url}${path}`); } }`, `svc.ts` with `class Svc { constructor(private crud: Crud) {} item(id) {
return this.crud.get(`/v1/items/${id}`); } }`, and a caller that calls `svc.item('7')`. Assert one call site at `svc.ts`'s
call to `crud.get` with `target.status === "complete"` and `target.value.path === "http://h/api/v1/items/{}"` (the folding
the fake resolver did not do in S1), **no** site inside `crud.ts`, and none at `svc.item`'s caller. Fails today: the site
is at `svc.ts` with path `/v1/items/{}` (no base) and `crud.ts:get` yields one unresolved site.
(b) `request-origins.adapter.test.ts`, test `a body behind a wrapper is read at the site the join reports`: assert
`ofBody` answers the same origins for a site at `svc.ts`'s `crud.get` call as for a direct `http.post` site, and that it
answers `no call at the reported site` only when the place holds no request — the `namesRequest` deletion is what makes
the first half fail today.
*Variants beyond the observed case:* a wrapper whose URL is a conditional (`'/items' + (all ? '' : '/' + id)`) yields two
shapes with residual `when`; at a call with an undecided argument the site is `unknown` with cause
`destination-undecidable` and `alternatives` naming both paths, and at a call with a literal `''` exactly one shape
remains and the site is complete. A wrapper with a gap (a body read from an unreadable source) yields one site with
`target.status === "unknown"`, cause `source-not-read`, and its evidence names the gap's place.

*GREEN acceptance:* both tests pass and the file's tests that asserted the wrapper-skip behaviour are rewritten to the
new rule (this is the one test change allowed here: the behaviour they pinned is deleted). Real probes:
`repro/plan-shopizer.json` → exactly one qualified link at `option.service.ts:38`, `basis: exact`, confidence `0.6`
(the route parameter is filled at run time), and **no** `crud.service.ts` places; `repro/plan-realworld.json` → one
`unknown (unresolved)` at `articles.service.ts:42`, cause `destination-undecidable`, and no other place;
`repro/plan-nname.json` → one `unknown (unresolved)` at `user-address.api.ts:32` (cause `destination-undecidable`), and
none of the ten `rest-client.service.ts` verb places. `repro/plan-jhipster.json` → unchanged (its site is already
exact) except that the `account.service.ts:73` group keeps its place.

*Corpus gate:* `--expect contract-consequences:± --expect trace:± --expect workspace:± --expect decisions:± --expect
impact:±` — call sites are the join's input, so links may appear, disappear or move; every difference is listed with why
it is right, and no expectation is set by which answers I saw.

*Docs:* RFC-0021 "Implementation evidence" gains the TypeScript reading; RFC-0010's entrypoint notes gain one sentence
(a request written inside a wrapper is attributed to the call that supplies its parameters, so `impact` and `trace` name
the caller's line); `AGENTS.md`'s command block is unchanged; the README row of `contract_consequences` and the tool
description keep their wording (no new cause) but `recovery` for an unresolved call site
gains: "a request made through a wrapper is a site at the call; the stated request names the path the code writes, and a
call matched only by a suffix names the gateway prefix or the server configuration that would declare it".

*Risk:* item 3 — `CallSite.target` and `UnresolvedCallSite` are consumed by `workspace`, `decisions`, `impact` and
`trace`. The shapes do not change; the *places* do. This is the unit where a wrong substitution would produce a false
link, which is why the fail-closed row above applies and why the corpus gate is `±` with a listed difference for every
change. **Risk: item 3 (contracts others consume).**

*High-risk item:* item 3; item 6 does not apply (the RED tests pin both the folded base and the gap).

### S3 — the flow starts from the summary's result shape

*Prerequisites:* S1, S2.

*Files:* edit `src/core/adapters/typescript/consumer-flow.walker.ts` and `consumer-flow.adapter.ts` (pass
`createRequestCallLookup(files)` into the walker — one dependency, no new port) and their tests, and remove
`consumer-flow.walker.ts` from `REQUEST_VOCABULARY_IMPORTERS` in
`src/composition/assembly-line.fitness.test.ts` (`VERBS` then has one importer, the rule module). Delete `requestKind`
(`:1005-1011`) and make `startCallSite` (`:135-146`) use the owner's `at(site)` and the summary's result shape;
`startCallResult` (`:147-156`) is unchanged. Do not touch `contract-consequences-queries.ts`, `consumer-sources.ts` or
the domain flow types.

*RED test:* `consumer-flow.adapter.test.ts`, test `a response read through a wrapper method named differently from a verb
is a use`. Fixture under `os.tmpdir()`: `account.ts` with
`load(id: string): Observable<Account> { return this.http.get<Account>(`/me/${id}`); }` and
`identity(id: string) { return this.load(id); }`; a component that calls `this.auth.identity('u1').subscribe(a => this.user = a)`
and a method reading `this.user.name`. After S2 the request is sited at the component's `identity('u1')` call (the
wrapper states a hole and that call supplies it), and `requestKind` rejects that call by name, so `startCallSite`
records `no call at the reported site`. Assert one `use` at the `name` read with the carrier at the `subscribe`, and
**no** such frontier. Fails today for exactly that reason.
*Variants beyond the observed case:* a wrapper returning `observe: 'response'` starts the value under `body`; a wrapper
whose result is `none` and a hypothesis with a property yields exactly one `unmodelled-flow` frontier with
`detail: "request-summary:no-body"`, not silence.

*GREEN acceptance:* both tests pass; the file's existing tests for a direct `http.get` site are unchanged (the leaf path
is preserved). Real probes: `repro/plan-shopizer.json` gains the two uses at `option.component.ts:101` and `:127`, which
is the oracle; `repro/plan-jhipster.json` keeps `account.service.ts:44` and adds no use at `login.service.ts:13` — that
place is a request call, not a read, and stays in the unresolved group.

*Corpus gate:* `--expect contract-consequences:± --expect trace:±` (trace starts values at sites too). Every difference
listed with why.

*Docs:* RFC-0022's flow-step table gains one row, "a call whose declaration's summary states a response body | the body,
through the container the summary names"; RFC-0013's effects section gains a sentence that a wrapper's site is its call.

*Risk:* none. A wrong start would report a use that does not exist, and the RED test pins one positive and one negative
(a call whose summary states no body yields a cut); the focused test and the suite are the check, with no independent
verifier.

*High-risk item:* none.

### S4 — the holder table

*Prerequisites:* S3.

*Files:* create `src/core/adapters/typescript/consumer-flow.holders.ts` (the table, data only) and a test; edit
`consumer-flow.walker.ts` at `methodCall` (`:404-427`) and `sink` to consult it. Do not touch `request-origins.*`, the
domain, or the adapter's public surface.

*RED test:* `consumer-flow.holders.test.ts`, test `a derived signal read in another class is a use, not silence`.
Fixture under `os.tmpdir()`: a service with `identity(): Observable<Account> { return
this.http.get<Account>('/me').pipe(tap(a => this.identity.set(a))); }`,
`private readonly userIdentity = signal<Account | null>(null); readonly account = this.userIdentity.asReadonly();`
and `who() { return this.userIdentity()?.name }`; a directive that injects the service, binds
`const current = svc.account` and reads `current()?.authorities` inside a `computed(() => …)`. Assert one `use` at the
directive's read with `path === ["authorities"]` (the carrier is the request the service makes), and one `use` at the
service's own `who()` read. Fails today: `account` never receives the value, the trail stops at the request's return,
and the directive appears in no finding and no cut.
*Variant beyond the observed case:* `form.patchValue(v)` then `form.getRawValue()` reads `v`'s properties (one `use`
per property the hypothesis names); a construct outside the table (`store.select('x')`) yields one `unmodelled-sink`
frontier with `detail: "holder:select"`.

*GREEN acceptance:* both tests pass; the walker's existing signal and `resource` tests are unchanged (their rows move
into the table). Real probe: `repro/plan-jhipster.json` gains a finding at `has-any-authority.directive.ts:28` and at
`settings.ts:48` (a `review` use, since a form control consumes the value), which the oracle lists as O3 and O4.

*Corpus gate:* `--expect contract-consequences:± --expect trace:±` — more carriers reach uses; every difference listed.

*Docs:* RFC-0022 P3's measured baseline ("Not seen on response data: stores, validators and conversions … so P3 builds
nothing for stores") is corrected with this measurement and the holder table; RFC-0013's reading plan gains a line.

*Risk:* none. A holder row could bind a value that does not flow (a form control's default value, a `computed` that
ignores its dependency), and the RED test plus the negative variant pin one positive and one frontier per row; the
focused test and the suite are the check, with no independent verifier.

*High-risk item:* none.

## Measurement

| Item | Unit that should close it | How to re-check |
|---|---|---|
| `N-shopizer-X-FIELD.A1-N1`, `A2-N1`, `CF-shopizer-X-FIELD` | S2 (link) + S3 (uses) | `repro/plan-shopizer.json`: one qualified link at `option.service.ts:38`, uses at `option.component.ts:101` and `:127`, no `crud.service.ts` place. Closed when both reads are findings. |
| `N-JHIPSTER-X-FIELD.A1-N1`, `A2-N1`, `CF-JHIPSTER-X-FIELD` | S4 (O3, O4); O2 is already answered | `repro/plan-jhipster.json`: findings at `account.service.ts:44`, `has-any-authority.directive.ts:28`, `settings.ts:48`; the two unresolved groups lose the places S3/S4 follow. Closed when O2, O3 and O4 all carry a finding. |
| `N-nname-X-FIELD.A2-N1`, `CF-nname-X-FIELD` | S2 (precision only; the cut is the decided answer, decision 1) | `repro/plan-nname.json`: one `unknown (unresolved)` at `user-address.api.ts:32`, cause `destination-undecidable`, whose evidence names the declaration that assigns the wrapper's base, and none of the ten `rest-client.service.ts` places. **Not closed by design**: the base is a run-time value and the provider value is not in the snapshot (only `src/environments/environment.mock.ts` exists), so no consumer can be named without inventing the base. |
| `CF-realworld-X-FIELD` | S2 (precision only; the cut is the decided answer, decision 2) | `repro/plan-realworld.json`: one `unknown (unresolved)` at `articles.service.ts:42`, cause `destination-undecidable`, and no leaf place. **Not closed by design**: the call matches only by `suffix` because `/api` is the server's context path or a gateway prefix declared outside the snapshot; the finding states the request and names the declaration that resolves it. |

Re-check by re-running the four plan files in `repro/` against the branch, one call at a time, then re-running the
graded sessions' calls (`sessions/*-X-FIELD.*/digest.md`, step 1) and comparing the findings to `tasks/<ws>.json`'s
oracle. Count: consumers named per item, unrelated places per answer, bytes per answer.

## Resolved questions

Owner decision 2026-11-09: every question is resolved as recommended here. No unit depends on a later choice.

| # | Question | Decision |
|---|---|---|
| 1 | A wrapper's base read from an `InjectionToken` whose provider value is a constant in the snapshot (`app.config.ts:55`: `{ provide: API_URL, useValue: environment.api_url }`): read it, or name it as a cut? | **Name it as a cut, and do not read provider values in this RFC.** Reading it closes neither measured item: `realworld`'s base is `https://…/api`, so its call `/api/articles/feed` still matches only by `suffix` (decision 2), and `nname`'s provider value is not in the snapshot at all (only `src/environments/environment.mock.ts`). A reading that changes no answer is not taken (ADR-0044 decision 5's precedent). The cut is `destination-undecidable`, its evidence names the declaration that assigns the field, and its recovery says how to state the base (declare the gateway, or hand the configuration in). Revisit only when a measured item turns on it; that is follow-up F1 with its own evidence. |
| 2 | A call matched only by `suffix` because the server's context path is not in the snapshot: may the answer follow it as a candidate, or keep the cut? | **Keep the cut, and name the two ways out in the recovery.** `suffix` is 0.5 confidence and may name another operation that ends the same way; following it would trade a missing consumer for a wrong one, which ADR-0042 forbids. S2's finding text states the request the code writes and the declaration that resolves it: a declared gateway prefix (`--gateway`, the protocol's `gateways`) or a declared server configuration. No unit reads context paths from a build output; that would be a new mechanism with no measured item behind it. |
| 3 | A wrapper whose request is inside a callback the table does not know (`fromEvent`, a custom `retryWhen`): a gap or nothing? | **Nothing.** Claiming a gap would make every function that calls an RxJS operator a summary gap, and the signal "this body issues no request" is what keeps the join quiet. The operation-level `no-call-site` finding remains the statement at the operation. The one exception is a call that matches a `ForwardingRow` but writes the carried position differently: that is a `destination-undecidable` gap at the call (S1 step 4), because the row promises a construct the code then uses otherwise. |

## Review responses

No finding is disputed. Every blocker and major naming RFC-0028 (findings 1-8) is accepted and fixed above; the three
minors (9-11) are fixed too. Where the review's fix and the lead's seam decision met, the seam decision wins and is
stated in "One owner for 'is this call a request'": the review proposed V5.2's lookup be made to consume the summary or
that the units be sequenced; the decision is that this RFC *owns* the function `createRequestCallLookup`, so V5.2 calls
it and no sequencing alternative remains.

## Decisions recorded in ADR-0050

- One method summary per declaration, computed by a monotone fixpoint over the snapshot's call edges, is the only place
  a request's parameters and a response's container are read (extends RFC-0021 S1 to every pack).
- A call site is the summary applied at the call: the wrapper's own base, consts and fields are part of the target.
- An ambiguous or unreadable summary is a cut at the call, never a merge and never a silent absence.
- One module answers "is this call a request of the project" for the TypeScript pack: the flow walker, the request-origin
  reader and ADR-0044 V5.2 call `createRequestCallLookup`; a name-based predicate is a second writer and is deleted.
- A value crossing a binding construct (a derived signal, a resource, a form control) is a carrier; a construct outside
  the pack's table is a named frontier.
