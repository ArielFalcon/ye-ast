# RFC-0035: Closing the extension model

- Status: Accepted, 2026-11-13. Owner, 2026-11-13: "apruebo todas las recomendaciones pendientes. dejalos cerrados"
  (I approve every pending recommendation; leave them closed); every open question is settled as recommended (see
  Resolved questions). ADR-0075 records its decisions.
- Related: RFC-0001, RFC-0007 (the model this RFC completes), ADR-0013, ADR-0014, ADR-0045 (decision 12), RFC-0036
  (the protocol kind), ADR-0075 (the decision this RFC designs)

**In short:** RFC-0007 says languages, frameworks and protocols are plugins behind fixed contracts. As built, only the
language seam is whole. One framework is a plugin and the other is wired by hand in the composition root; the core's
ports, use cases and domain name one framework; closed unions name the two languages; and one adapter folder holds a
language together with its framework. A third framework today touches the domain, the ports, a use case and the
composition root. This RFC states the rules that make a plugin the only thing a new framework adds, and the refactor
that reaches them with no change in any answer.

## As built against RFC-0007

| RFC-0007 says | As built | Evidence |
|---|---|---|
| A framework is a plugin | Three plugins are registered, all for one language | `src/composition/framework-plugins.ts:11-13` |
| | The other framework's readers are built and joined by hand | `src/composition/compose.ts:168,177,183,349` |
| The core is agnostic through ports | Three ports are named after a framework | `src/core/ports/angular-consumer-syntax.port.ts`, `angular-declarations.port.ts`, `angular-metadata.port.ts` |
| | A use case and a dependency of the impact family are named after it | `src/core/application/relations/angular-relations.ts`, `src/core/application/impact/impact-queries.ts:84` |
| | Domain types are named after it, and relation kinds are its vocabulary | `src/core/domain/relations/angular-class.ts`, `src/core/domain/relations/relation.ts:3` |
| | An impact policy names its synthesizers | `src/core/domain/impact/edge-policy.ts:63` |
| A language is a plugin | Language identity is a closed union in four places | `src/core/domain/languages/profiles.ts:10`, `src/core/domain/shared/fact.ts:167`, `src/core/domain/change/source-tokens.ts:25`, `src/core/domain/map/entrypoint-map.ts:33` |
| An adapter talks to one technology | `adapters/spring/` (about 9,000 lines) holds the Java resolver and the framework's readers; `adapters/typescript/` holds eleven source files of one framework | `src/core/adapters/spring/`, `src/core/adapters/typescript/angular-*.ts` |
| | One frozen exception lets that folder read another adapter | `.dependency-cruiser.cjs:74-79` |
| An application's idioms are data | Library vocabularies are tables in adapter code | `src/core/adapters/spring/http-client-vocabulary.ts`, `data-vocabulary.ts`, `event-vocabulary.ts`, `java-symbols.ts:177` |

The language seam (`LanguagePack`, `src/core/ports/language-pack.port.ts`) is real and is the model to follow: the line
hands each reader only its own paths, and the binding rule reads `LanguageProfile.typing`, not a language name.

## Rules

### 1. The core names no language and no framework

- A language and a framework are identified by a value their pack or plugin registers. The four closed unions become
  that registered identity; the map's scope is derived from what is registered, sorted, so today's bytes are kept.
- No file under `core/domain`, `core/application` or `core/ports` is named after a framework or a language, and none
  holds one's name as a literal outside a test. A fitness test holds it, in the precedent of
  `src/core/adapters/syntax.single-rule.test.ts`.

### 2. A framework reaches the core only through its plugin

- Every framework reader is a member of a `FrameworkPlugin`, and plugins are registered in one place
  (`composeFrameworkPlugins`). The composition root builds no framework adapter directly; an architecture rule holds
  it.
- The contract grows by the stages the hand-wired framework uses and the plugin lacks:

| Stage | Today | In the contract |
|---|---|---|
| Entrypoints | plugin for one framework, hand-joined for the other | `entrypoints`, for both |
| Consumer call sites | plugin `consumer` for one, `createJavaCallSites` for the other | `consumer`, for both |
| Data effects | hand-wired (`compose.ts:349`) | a new optional `effects` stage |
| Framework relations | a named use case and a named dependency of impact | a new optional `relations` stage; the relation kinds a plugin emits are values it declares |
| Synthesized edges to ignore | a list in the domain | declared by the plugin that owns the synthesizer |

- A stage a plugin cannot answer is declared `absent`, as today, and the line answers `capability-absent`.

### 3. One adapter folder per technology

| Today | Target |
|---|---|
| `adapters/spring/` | `adapters/java/` (parser holds, project, names, receivers, dispatch, call-site owner) and `adapters/spring/` (routes, events, data effects, vocabularies) |
| `adapters/typescript/angular-*.ts` | beside the existing `adapters/frameworks/angular/` |
| the frozen exception | deleted: a framework adapter receives its language's readers injected by composition, as the first plugin already does (`framework-plugins.ts:12`) |

The exception list shrinks to nothing, which is the only direction it may move.

### 4. A library vocabulary is declared data

A table that says "this member of this library type issues a request, reads data, publishes an event" is a value of
the plugin, with one generic matcher per language that reads it. The matcher asks the type's identity; under RFC-0033
a declared classpath answers it by qualified name.

### 5. The proof is a second framework that costs no core change

The model is closed when a framework enters with a diff confined to its adapter folder, its fixtures and one line of
registration. Which framework, and when, is ADR-0013's question and is not answered here.

## Migration

Every step is a refactor. The corpus gate expects no difference at each one.

| # | Step |
|---|---|
| 1 | Registered identities replace the four unions; the fitness test for names in the core lands with the known files as a frozen exemption list that only shrinks, and the list is empty after step 4 |
| 2 | The hand-wired framework becomes a plugin over the readers it has; `compose.ts` loses its direct calls |
| 3 | The `effects` and `relations` stages; the named use case, ports and impact dependency become the generic stage |
| 4 | The domain's relation kinds and ignored synthesizers become plugin values |
| 5 | The folder split and the deletion of the frozen exception |
| 6 | Vocabularies as plugin data |

Steps 2 to 4 are ordered by what unblocks a second framework; 5 and 6 are independent of them.

## What this RFC does not do

- It adds no coverage. No answer changes.
- It does not give `.tsx`, `.jsx` or `.js` a language profile. That is new coverage and enters under ADR-0013, with
  the ledger row that measures it.
- It does not make dispatch a core layer (ADR-0044 decision 3 stands).

## Resolved questions (owner, 2026-11-13: "apruebo todas las recomendaciones pendientes")

| # | Question | Decision |
|---|---|---|
| 1 | Is this refactor worth its cost before a second framework is asked for? | Steps 1 and 2 yes: they are small and remove the hand-wiring that every multi-repository fix currently has to thread through. Steps 3 to 6 when a second framework for either language is scheduled, so the contract is shaped by a real second case and not guessed |
| 2 | Are relation kinds fully opaque to the core? | No. The core keeps `references`; a plugin kind declares the one property the core reads, whether the edge carries dependence for impact |
| 3 | Does the folder split run in one change? | Yes, alone, with no behavior in the same commit: it is a move, and a reviewer must be able to verify it as one |
