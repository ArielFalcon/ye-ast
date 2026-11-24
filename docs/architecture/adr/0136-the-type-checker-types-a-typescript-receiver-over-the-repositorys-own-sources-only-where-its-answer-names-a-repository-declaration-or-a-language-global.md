# ADR-0136: The type checker types a TypeScript receiver over the repository's own sources, only where its answer names a repository declaration or a language global

- Status: Accepted, 2026-11-17, owner. Owner, 2026-11-17: "acepto las sugerencias para las decisiones pendientes" (I accept the suggestions for the pending decisions).
- Decision source: Owner, 2026-11-17: "deja escrito todos los RFC y ADR necesarios para que se implemente en otra sesion
  por un agente con menos capacidad que tu, asi que todo debe estar explicito y sin poco margen a que el agente tenga que
  tomar decisiones improtantes o inventarse implementaciones" (write every RFC and ADR needed so that a less capable
  agent implements it in another session; everything must be explicit, leaving almost no room for that agent to take
  important decisions or invent implementations). The decision serves this sentence of the request of the same day:
  "Mejorar la calidad de analisis de lo que ya existe, corregir problemas, optimizar recursos y aprovechar mejor los
  recursos que ya tiene disponible" (improve the quality of the analysis that exists, fix problems, optimise resources
  and make better use of the resources already available).
- Related: [RFC-0044](../rfc/0044-one-receiver-typing-reading-for-typescript.md) ("The checker level", unit U8),
  [ADR-0008](0008-typescript-compiler-api-source.md) (the compiler API and where it is used),
  [ADR-0010](0010-trust-modes.md), [ADR-0018](0018-type-information-as-a-fact-input.md),
  [ADR-0035](0035-derived-facts-are-retained-by-content.md), [ADR-0037](0037-host-declared-build-outputs.md),
  [ADR-0111](0111-a-write-the-compiler-proves-cannot-reach-a-class-neither-refuses-its-member-proof-nor-is-cited.md),
  [ADR-0135](0135-one-owner-types-a-typescript-receiver-in-a-fixed-order-of-proofs-and-every-family-asks-it.md)
  decision 2
- Supersedes: nothing. ADR-0018 rejected the checker as a general fact input and ADR-0037 bounds it to a declared
  directory; this record adds one narrower use that neither covers and contradicts neither

**In short:** the program ADR-0111 already builds over the repository's own sources may answer one more question,
the type of a receiver no declaration types, as the last proof of ADR-0135. Its answer is taken only when it names
a class of the repository or a global of the language's library. It is built only if a measurement shows it
settles cuts in more than one application at no more than the cost of the query it serves.

## Context

Verified at commit `62a41b28a`:

| Fact | Evidence |
|---|---|
| ADR-0018 rejected the checker as a fact input: latency ×2 to ×3.4, memory ×2 to ×3.6, an out-of-memory failure, 0 to 25 cuts removed; without the dependency closure the names it could not resolve were framework primitives | ADR-0018, "Context" |
| ADR-0037 accepts the checker over a directory the host declares; without it the checker binds 12.9% to 46.9% of the calls; a live tree is not typed | ADR-0037; `nodeModulesReading`, `src/core/application/snapshot/base-reading.ts:223` |
| A sources-only program already exists: engine-owned options, a confined host, no `tsconfig`, built lazily, asked one question (`mayHold`) by one consumer | `createReceiverTypes`, `OPTIONS`, `src/core/adapters/typescript/receiver-types.ts:26`; consumed at `angular-metadata.adapter.ts:62`; measured by ADR-0111 at 609 ms and 147 MB for 715 files |
| The owners of `ts.createProgram` are fixed by a fitness test | `src/core/adapters/syntax.single-rule.test.ts` (`lexical-bindings.ts`, `receiver-types.ts`, `type-bindings.adapter.ts`) |
| After the syntactic levels of ADR-0135, the receivers left untyped are element accesses, results of generic calls, destructured bindings and members of outside types | RFC-0044, table T13 to T17 |
| How many of those a sources-only program settles is not known without a run | RFC-0044, measurement M4 |

| Option | Verdict |
|---|---|
| Never use the checker for receivers | Rejected for now: the program is already paid for where relations ask it, and repository-to-repository inference (an element of an array of a repository class) needs no dependency |
| Use it for every receiver | Rejected: ADR-0018's cost, and without the packages' declarations an imported type is an error type, so the answer for the commonest receivers would be nothing |
| Last proof, repository classes and language globals only, behind a measurement | Chosen |

## Decision

1. **Where it may run.** Only inside `src/core/adapters/typescript/receiver-types.ts`, over the same lazily built
   program: the snapshot's own TypeScript sources through the confined host, engine-owned compiler options, no
   project configuration read, no directory outside the snapshot, no plugin, no emit. Nothing of the repository is
   executed (ADR-0010).
2. **When it is asked.** Last, for a receiver every earlier level of ADR-0135 refused, and never for a receiver
   those levels refused on purpose: `this` and `super`, a root name, a dynamic scope, a type assertion.
3. **What is accepted.** The checker's type of the receiver expression, with `null` and `undefined` removed, is
   accepted when it is (a) one object type whose symbol has every declaration in one source file of the snapshot:
   the answer is that repository declaration; (b) one object type whose symbol has every declaration in the
   compiler's default library files: the answer is that language global; (c) a primitive `string`, `number`,
   `bigint` or `boolean`: the answer is the matching global.
4. **What is refused.** `any`, `unknown`, `never` and an error type; a type parameter, and any receiver inside a
   generic scope; a union of two or more members after decision 3's removal; an intersection; an anonymous object
   type; a symbol with declarations in more than one file; a declaration in a file that is neither a source of the
   snapshot nor a default library file. A refusal keeps the cut the earlier levels left.
5. **It never names a package.** No answer of this level is a package export. Without the package's declarations
   an import of it resolves to an error type, which decision 4 refuses; with them, the declared directory of
   ADR-0037 is the owner.
6. **What kind of proof it is.** A declared type in the sense of ADR-0135 decision 3: never exact, attributed per
   declaration, and a repository answer offers candidates only for a nominal class with a wholly proven hierarchy.
7. **Where its answers live.** As derived facts keyed by the snapshot's TypeScript sources (ADR-0035): one
   derivation per set of sources, plain data by site; the program is dropped when the derivation ends, as ADR-0037
   requires of its own. A request never holds a program.
8. **Live reads.** A read of a live tree does not ask this level; the answer is the one the earlier levels give.
9. **Cost.** No time or memory limit is defaulted. The level is built only after RFC-0044's measurement M4, by its
   table: built when it settles places in two or more applications and, in each, building the program and asking
   costs no more than the base `trace` query measured in the same run; not built when it settles nothing; reported
   to the owner, undecided, when it settles places in one application only or costs more than the query.
10. **The bound.** With this level a cut may become a narrower cut, a step at the one body a nominal hierarchy
    proves, or an external call of a language global under ADR-0133's rule. No step and no external call of the
    earlier levels changes.

## Consequences

- If M4 says "not built", the level is not built: the measured numbers are added to this record, and ADR-0135's order has
  three levels.
- `receiver-types.ts` answers two questions over one program; the fitness test on `ts.createProgram` is unchanged.
- The first query of a commit that reaches this level pays the program once; later queries of the same sources
  read the kept answers.
- Receivers typed by a package stay with the syntactic levels and with ADR-0037; this record does not shorten that
  gap.

## Not decided here

- Typing arguments, return values or anything other than a member call's receiver with the checker.
- Building the program for a live tree.
- Raising or replacing ADR-0018: its rejection of the checker as a general fact input stands.
