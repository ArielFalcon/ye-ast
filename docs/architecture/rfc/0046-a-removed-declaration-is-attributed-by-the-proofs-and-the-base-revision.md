# RFC-0046: A removed declaration is attributed by the proofs the head holds and, where they leave it open, by the base revision

- Status: Accepted, 2026-11-17. Owner, 2026-11-17: "acepto las sugerencias para las decisiones pendientes" (I accept the suggestions for the pending decisions); every question is settled as its "Resolved questions" table states.
- Related: ADR-0140 (the decision this RFC designs), ADR-0042 (reason `removed-declaration`), ADR-0043, ADR-0036
  (dependence is the compile-time binding), ADR-0041 (one owner of what a call binds to), ADR-0079, ADR-0088, ADR-0097,
  ADR-0015 (the index is kept by content), ADR-0019, ADR-0075, RFC-0010 ("Removed-declaration cuts"), RFC-0018

**In short:** a declaration removed whole leaves no node, so impact lists every unresolved reference at head that spells
its name as a candidate, whatever the proofs the engine holds say that reference binds to. The cut asks the one owner of
call binding (`CallBindings.boundCalls`) what each candidate binds to and drops those it proves bound to another
declaration or outside the repository, then those whose receiver type is proven unrelated to the removed declaration's
owner. What stays is measured, and only then does impact open the merge base's index to tell the callers the base
resolved to the removed declaration from the references that never were. It moves the `impact` rows
`removed-declaration` (baseline 27 TypeScript and 5 Java cuts) of the cut ledger.

## Problem

| Evidence | Source |
|---|---|
| `removedDeclarationCuts` takes `references`, `removed`, `known`, `bound`, `localParameters`; it pairs a reference with a removed declaration by `nameTail(name)` and `mayReach`, and no binding of the reference decides | `src/core/domain/impact/impact-cuts.ts`, `removedDeclarationCuts` |
| Its sibling `unresolvedLinkCuts` also receives `settled`, `members` (`MemberReferenceProofs`) and `boundAway` | same file, `unresolvedLinkCuts`; call sites in `src/core/application/impact/impact-queries.ts`, `impactOf` (the two `...unresolvedLinkCuts(` and the one `...removedDeclarationCuts(` lines) |
| A removed declaration is `{ file, name }`: no kind, no owner | `src/core/domain/change/seeds.ts`, `RemovedDeclaration`, filled in `selectSeeds` (`removed.push(...change.removedNames.map(...))`) |
| The name is read from one text line of the diff, per file, and dropped when any added line of the same file declares the same name | `src/core/domain/change/diff-reader.ts`, `createDiffReader` (`declaredIdentifier(line.slice(1), ...)`, `removedNames: ... .filter((name) => !addedNames.has(name))`); `src/core/domain/change/declared-identifiers.ts`, `declaredIdentifier` |
| Only TypeScript and JavaScript names are checked against the base and head sources; every other name stays as the diff text gave it | `src/core/adapters/typescript/declaration-evidence.adapter.ts`, `createDeclarationEvidenceReader` (`if (!/\.[cm]?[jt]sx?$/.test(path) ... return names`), called from `impact-queries.ts`, `readChange` (`deps.declarationEvidence.validate`) |
| The corpus holds 32 `removed-declaration` cuts in the baseline ledger: 27 TypeScript (26 from one change of an Angular application, rewritten stores and pages) and 5 Java | `ye-ast_test/reports/2026-11-17-r4-u21b/report.json`, `ledger.candidate.rows` (`family: impact`, `reason: removed-declaration`) |
| The removed names are generic property or member names (`error`, `isLoading`); two removed declarations of the same name list the same 25 places | the audit of the 32 cuts of that report (their places per query); U3 reproduces it for what remains |
| The base tree is prepared and its sources are read, but only the head index is opened | `impact-queries.ts`, `ofChangeAtRevision` (`preparedBase`, `baseTree`) and `readChange` (`head.open()` only) |
| The head reader can open the index of any prepared commit: `indexHead` takes `Pick<PreparedCommit, "root" \| "tree" \| "materialize">`, which `preparedBase.value` satisfies, keyed by content | `src/core/application/snapshot/head-reading.ts`, `HeadReader.indexHead`; `src/core/application/snapshot/read-snapshot.ts`, `PreparedCommit` |
| Renames are not detected: a moved file is a deletion plus an addition | `src/core/adapters/git/git-vcs.adapter.ts`, `DIFF_OPTIONS` (`"--no-renames"`) |
| The one owner of what a call binds to exists and is already built for impact | `src/core/application/navigation/call-binding.ts`, `CallBindings.boundCalls`; `src/core/application/navigation/edge-targets.ts`, `EdgeTargets.bindings` |

**Two premises of the first idea are false, verified in the code.** The idea was to hand the removed-declaration cut the
same `settled`, `members` and bound-use proofs its sibling receives.

1. They are keyed by a **walked** declaration: `settledUses` and `boundUses` return `declarationUseKey(anchor of a
   reached node, occurrence)`, and a removed declaration is no node. `inbound-edges.ts`, `memberProofs` hands the map
   `memberTargets`, which `indexMemberUses` fills only when a walked node's name is the name of a member proof
   (`provenMemberUsesOf`), and only for members of kind `method` (`joinMember`, `matches(proof.member, "method")`).
2. A bound-use key does not always prove a binding elsewhere. `src/core/application/navigation/reverse-calls.ts`,
   `into`, pushes `{ node, occurrence, away: [] }` when the call is only *attributed* to the node (the branch
   `attributed.push({ node, call })`), and `boundUses` in `impact-queries.ts` keeps `away: []` entries
   (`reference.away.every(...)` is true for an empty list). Such a key means "another cut covers this call", not "this
   call binds to another declaration".

**Root cause.** The removed-declaration cut is the only producer of an impact cut that never asks the owner of call
binding what the reference binds to: it attributes by name alone, so a reference the engine proves bound to another
declaration, or to a type outside the repository, is listed beside the references it cannot place.

## Design

### Owner

| Fact | Owner | Why |
|---|---|---|
| What a written call binds to (a declaration, a declaration the proof places, outside the repository, nothing proven) | `CallBindings` (`call-binding.ts`), through `EdgeTargets.bindings` | ADR-0041 decision 1: one owner for every family; it reads the member proofs, the receiver bindings and the import proofs |
| Which references are candidates of a removed declaration, and the cut that lists them | `removalCandidates` and `removedDeclarationCuts` (`impact-cuts.ts`) | the only producer of the cut today; the pairing rule moves into one exported function so the filter reuses it |
| Which candidates a binding proves are no use of the declaration | `removedNotUses` (new, `src/core/application/impact/removed-uses.ts`) | the one place that compares the owner's answer with the removed declaration; the domain receives only its result |

### Contract

In `src/core/domain/impact/impact-cuts.ts`:

```ts
/** A reference at head and the removed declaration whose name it spells, as the cut pairs them. */
export interface RemovalCandidate {
  reference: UnresolvedUse;
  declaration: RemovedDeclaration;
}

/** Every (reference, removed declaration) pair `removedDeclarationCuts` lists before a proof of non-use is applied. */
export function removalCandidates(
  references: readonly UnresolvedUse[],
  removed: readonly RemovedDeclaration[],
  known: ReadonlySet<string> = new Set(),
  bound: ReadonlyMap<string, string> = new Map(),
  localParameters: ReadonlySet<string> = new Set(),
): RemovalCandidate[];

export function removedDeclarationCuts(
  references: readonly UnresolvedUse[],
  removed: readonly RemovedDeclaration[],
  known: ReadonlySet<string> = new Set(),
  bound: ReadonlyMap<string, string> = new Map(),
  localParameters: ReadonlySet<string> = new Set(),
  /** `declarationUseKey(declarationAnchor(removed.file, removed.name), referenceKey(reference))` of every pair a proof says is no use. */
  notUses: ReadonlySet<string> = new Set(),
): Cut[];
```

In `src/core/domain/change/seeds.ts`:

```ts
export interface RemovedDeclaration {
  file: string;
  name: string;
  /** The names of the types that declared `name` in the base source, one per removed instance; set only when the base source places every removed instance directly in a named class or interface (RFC-0046 U2). */
  owners?: readonly string[];
}
```

In `src/core/domain/change/diff-reader.ts`, `FileChange` gains `removedOwners?: Readonly<Record<string, readonly string[]>>`
(by removed name). In `src/core/ports/declaration-evidence.port.ts`, `DeclarationEvidenceReader` gains the method written
under U2.

In `src/core/application/impact/removed-uses.ts` (new):

```ts
export async function removedNotUses(input: {
  candidates: readonly RemovalCandidate[];
  bindings: CallBindings | undefined;
  store: CodeGraphReader;
  signal?: AbortSignal;
  /** U2 only. */
  relation?: OwnerRelation;
}): Promise<ReadonlySet<string>>;
```

### Rules

**R1. The candidate pairing is one function.** `removalCandidates` holds today's body of the loop of
`removedDeclarationCuts` unchanged: `isKnownReference`, `mayReach`, the `bound` import proof, the `localParameters`
proof, `nameTail`. `removedDeclarationCuts` is `removalCandidates(...)` filtered by `notUses`, grouped by
`declarationAnchor(declaration.file, declaration.name)`, one cut per removed declaration, places `placeAt(reference.file,
reference.line)`, reason `removed-declaration`, reach `callers-of` the anchor. The cut's shape does not change.

**R2. The filter drops a pair only on a positive binding.** For each candidate `c` with a defined, unique
`referenceKey(c.reference)`, whose `reference.kind` is `calls`, `references` or `instantiates`:

```ts
const [binding] = await bindings.boundCalls([{ body, reference: c.reference }], signal);   // body: the symbol of reference.from
const anchor = declarationAnchor(c.declaration.file, c.declaration.name);
const elsewhere = (target: { file: string; name: string }): boolean => declarationAnchor(target.file, target.name) !== anchor;
const notUse =
  binding.kind === "outside" ||
  (binding.kind === "declaration" && elsewhere(binding.target)) ||
  (binding.kind === "receiver" && binding.target !== undefined && elsewhere(binding.target)) ||
  (syntaxMemberOf(binding) !== undefined && elsewhere(syntaxMemberOf(binding)!)) ||
  (binding.kind === "receiver" && binding.outside === true && binding.dispatch === undefined);
if (notUse) notUses.add(declarationUseKey(anchor, referenceKey(c.reference)!));
```

`syntaxMemberOf` is the existing export of `call-binding.ts` (a receiver binding with no target whose proof states a declaration only the syntax holds, none when a provider may replace the receiver). A binding of kind
`unbound` or `declared` never drops. Every other input (no binder, no key, a duplicate key, an abort, a `kind` that is
`extends`, `implements`, `imports` or `calls` of an unplaced body) keeps the pair.

**R3. The homonym rule.** A binding whose target has the removed declaration's own anchor (`file::name`) keeps the pair.
This is the case the question named: a member of the same file and name that replaced the removed one (an overload
that remains, a member of another type of the same file, a replacement the diff text did not read). The anchor cannot
tell the removed declaration from the one that stayed, so the reference is a dependent that still needs review, as every
cut does for a homonym of its file (`homonymsOf` in `call-binding.ts` makes the same choice for walked declarations).
R6 refines this case when the owners are known.

**R4. A binding to another declaration is dependence on that one.** ADR-0036: dependence is the compile-time binding. A
reference the head binds to an existing declaration `D` depends on `D`. If `D` is part of the change (added or edited
lines), the walk already reaches `D`'s dependents; if not, the removal did not change what the reference depends on.

**R5. An outside receiver with a dispatch keeps the pair.** `binding.dispatch !== undefined` (Java: a receiver declared
as a type outside the repository, ADR-0079) is not dropped: whether the removed method may still run under that type
needs `mayRunUnder` over a declaration, and a removed declaration has none. The pair stays a candidate (Not covered).

**R6 (U2). The owner relation.** For a candidate with `declaration.owners` defined and a binding of kind `receiver` with
no `target`, `proof.type` a repository type `T` (`proof.link` is `field`, `local` or `syntax`), the pair is no use when
every owner `O` of `owners` satisfies `unrelated(T, O)`:

```ts
unrelated(T, O):
  Oh = the one declaration of kind class/interface/component named O in store.symbolsInFiles([declaration.file])   // none or several: false
  upT = [T, ...navigation.typesAround(T, "up").map(({ type }) => type)]
  upO = [Oh, ...navigation.typesAround(Oh, "up").map(({ type }) => type)]
  return reading.unplacedSupertypes([T, Oh]).length === 0                    // both hierarchies closed
      && !upT.some((type) => type.id === Oh.id) && !upO.some((type) => type.id === T.id)
      && upT.every((type) => !changedFiles.has(type.file))                     // T's hierarchy is the same at base
```

A pair whose binding is the one the member proof placed, or whose owner no longer exists at head, stays.

**R7 (U2 refinement of R3).** A binding of kind `declaration` or `receiver` with a `target` of the removed anchor, where
`owners` is defined, is no use when no owner of `navigation.ownersOf(target)` has a name in `owners`.

### Soundness

| Rule | Why it cannot assert something false | The input that would break it and how it is excluded |
|---|---|---|
| R2 outside, declaration, receiver target | A removed declaration is absent at head, and the binding is the head's compile-time binding (ADR-0036), so a reference bound to an existing declaration or outside the repository is not bound to it. A reference that depended on the removed one at base and now binds to `D` was healed by `D`, which is the dependence the walk tracks (R4) | A module augmentation that declares the removed member on a library type: a reference through a library-typed field is then dropped. The engine already makes this assumption for every external proof (`isKnownReference`, ADR-0019); it is kept and listed in Resolved questions as such |
| R2 `syntaxMemberOf` | The head binds the call to a declaration the syntax states, which is not the removed one | Conservatism, not a proof need: `syntaxMemberOf` answers none for a `replaceable` receiver (ADR-0093 decision 3), and the rule reuses it unchanged, so such a pair stays |
| R3 | An equal anchor cannot separate the removed declaration from a remaining one | Kept: never dropped |
| R6 | The reference binds to a member of `T`'s hierarchy; the removed member belonged to `O`; with both hierarchies closed, `O` is not in `T`'s and `T` is not in `O`'s, so the reference never named `O`'s member. The third conjunct covers a change that removed `T extends O` itself: that edit is in a changed file, so the relation at base may differ and the pair stays | A closed hierarchy that a structural type satisfies (TypeScript): the reference still binds by `T`'s own declared members, never `O`'s, so no use of `O`'s member can be written through `T` |
| R5 | n/a | Kept |

### What the design does not do

- It adds no cut reason, no cut field and no output field: the cut is the same, with fewer places (ADR-0042 reason table
  unchanged). A cut whose places all drop is not emitted, as today when nothing names the removed name.
- It never turns a candidate into a proven dependent, and never lists a new place. It only removes places.
- It reads no base source and opens no base index in U1 and U2.
- It does not use a same-name addition elsewhere as evidence (R8 below).

**R8. Moves stay out.** `--no-renames` makes a declaration moved from file A to file B a removal at A plus an addition
at B. No rule suppresses the removal because an addition of the same name, kind and owner exists in another file of the
change. A reference the head proves bound to the added declaration is already dropped by R2 (its target has another
anchor). A reference that is still unresolved may be a use of the removed declaration, a use of the moved one, or
neither; the sources do not say, and an added name is evidence of an author's intent, not of a binding. A rule that
dropped it would drop a real dependent when an unrelated declaration reuses the name. The base revision reading (U4) is
the proof route for them.

### The base revision reading (U4, decided from the code)

| Question | Answer, with evidence |
|---|---|
| Can impact open the base index for the removed declarations only? | Yes, with no new port. `readChange` already receives `basePrepared` (`PreparedCommit`: `root`, `tree`, `materialize`); `HeadReader.indexHead` takes exactly that subset, and `changeReader` is the reader whose `sourceSelection` the base tree was prepared with (`ofChangeAtRevision`, `changeDeps`). A new `openBase` closure, built beside `open`, calls `changeReader.indexHead(preparedBase.value, readScope.directory, signal)`. `BaseReadings.open` takes any store, so a reading over the base store is `readings.open({ tree: baseTree, prepared: basePrepared, hold, store, digest, snapshot, request })` |
| What does it cost? | `indexHead` first asks `deps.indexes.obtain({ content, ... })` with the content digest of the base tree's export (ADR-0015): a kept index for that exact content is a lookup. Otherwise `deps.graph.index(root, ...)` builds the whole base index: the dominant cost of an impact query (ADR-0015, Context). The base export is already materialized to read its sources unless retention holds them (`prepareCommit`, `load`). `callers` and `impact` read with different `sourceSelection`, so a head index kept by a `callers` query is not the base index of an `impact` query |
| Is the base index available without a new build? | Not in general. Only when an earlier query of the same reader family kept an index of that exact content (for example an earlier `impact` whose head was this commit). The unit therefore opens it only when removed declarations still list places after R2 to R7, and reports the wall time |
| What does the answer become? | See U4's rules: a head reference that the base resolved into the removed declaration, at a place the change did not touch, is a dependent to review (kept, and said so in `Cut.cause`); one the base resolved to another declaration at an untouched place is dropped; everything else stays as today |

## Delivery units

| Unit | Goal | Prerequisites |
|---|---|---|
| U1 | The removed-declaration cut drops a reference the owner of call binding proves bound elsewhere | none |
| U2 | `RemovedDeclaration.owners` and the owner relation (R6, R7) | U1 |
| U3 | Measurement: what remains on the corpus, and the decision for U4 | U1, U2 on `main` |
| U4 | The base revision reading of the remaining candidates (conditional on U3) | U3 |

Every unit starts with: merge `main`, locate the symbols named below by name, stop and report if one is gone, as the
other branches (the latency program, ADR-0116 to ADR-0121) edit the neighbouring files.

### U1: the binder-based filter

- **Goal:** `removedDeclarationCuts` lists only references the owner of call binding does not place elsewhere.
- **Prerequisites:** none.
- **Files to edit:** `src/core/domain/impact/impact-cuts.ts` (extract `removalCandidates`, add the `notUses`
  parameter), `src/core/domain/impact/impact-cuts.test.ts`, `src/core/application/impact/impact-queries.ts` (`impactOf`),
  `src/core/application/impact/impact-queries.test.ts`. **Files to create:**
  `src/core/application/impact/removed-uses.ts`, `src/core/application/impact/removed-uses.test.ts`. **Must not
  touch:** `inbound-edges.ts`, `reverse-calls.ts`, `unresolvedLinkCuts`, `boundUses`, any adapter.
- **Steps:**
  1. In `impact-cuts.ts` move the body of the `for (const reference of references)` loop of `removedDeclarationCuts`
     into `export function removalCandidates(...)` returning `{ reference, declaration }` pairs in the order the loop
     visits them (references in input order, declarations in `byName` order). Keep every `continue` exactly.
  2. Rewrite `removedDeclarationCuts` as: pairs = `removalCandidates(...)`; skip a pair when `referenceKey(reference)`
     is defined, in `uniqueReferenceKeys(references)`, and `notUses.has(declarationUseKey(declarationAnchor(
     declaration.file, declaration.name), key))`; group as today. The signature gains the sixth parameter of the
     Contract.
  3. Create `removed-uses.ts` with `removedNotUses` of the Contract (without `relation`): `if (bindings === undefined)
     return new Set()`; eligible = candidates with a defined unique key and `reference.kind` in `["calls", "references",
     "instantiates"]`; `bodies = new Map(store.symbolsByIds([...new Set(eligible.map(({ reference }) => reference.from))])
     .map((symbol) => [symbol.id, symbol]))`; one `boundCalls` batch for the distinct references (by key), in input
     order; for each candidate apply R2 exactly as written. A reference whose `from` is not in `bodies` is skipped.
  4. In `impactOf`, before the `removedDeclarationCuts` argument list, compute `const notUses = await removedNotUses({
     candidates: removalCandidates(unresolved, selection.removed, knownPlaces, input.proofs?.bound,
     input.proofs?.localParameters), bindings: targets?.bindings, store, signal: input.signal })` (`targets` is already
     `input.reading.edgeTargets(input.typed)`), and pass it as the sixth argument at the existing call. `impactOf`
     already holds `unresolved` (`GraphUnresolvedReference[]`, structurally an `UnresolvedUse[]`).
- **RED tests:**
  - `impact-cuts.test.ts`, `a reference proven no use of a removed declaration is not listed, and only for that declaration`.
    Fixture: `const removed = [{ file: "src/Repo.java", name: "save" }, { file: "src/Other.java", name: "save" }]; const
    proven = use("repo.save", "calls", "src/B.java", 9); const open = use("repo.save", "calls", "src/C.java", 4);
    const notUses = new Set([declarationUseKey("src/Repo.java::save", referenceKey(proven)!)])`. Call
    `removedDeclarationCuts([proven, open], removed, new Set(), new Map(), new Set(), notUses)`. Before: both cuts list
    `src/B.java:9` (and the call does not type-check: six arguments). After: `[{ at: ["src/Other.java::save",
    "src/B.java:9", "src/C.java:4"], ... }, { at: ["src/Repo.java::save", "src/C.java:4"], ... }]` (anchors ordered as
    `removed` is), reason `removed-declaration`, reach `callers-of` the cut's own anchor.
  - `removed-uses.test.ts`, `a reference the binder places on another declaration, or outside the repository, is no use; one it places on the removed anchor, or leaves unbound, is`.
    Fixture: a fake `CallBindings` whose `boundCalls` answers by `reference.line`: line 3 `{ kind: "declaration", link:
    "declared-receiver", target: fakeNode("Kept", "method", "src/store.ts", 3, 4, "write") }`, line 4 `{ kind:
    "outside", form: "chain", origin: { kind: "external", module: "lib" } }`, line 5 `{ kind: "declaration", link:
    "own-member", target: fakeNode("Own", "method", "src/old.ts", 9, 9, "write") }`, line 6 `{ kind: "unbound", form:
    "member", candidates: [], attributed: [] }`, line 7 `{ kind: "receiver", proof: { link: "none" }, candidates: [],
    attributed: [], target: fakeNode("Sub", "method", "src/sub.ts", 2, 2, "write") }`, line 8 `{ kind: "receiver", proof: {
    link: "none", replaceable: true }, candidates: [], attributed: [], declaration: <a ModelDeclaration of
    src/sub.ts::write with no symbol> }`, line 9 the same as line 8 without `replaceable`, line 10 `{ kind: "receiver",
    proof: { link: "external", holds: "lib" }, candidates: [], attributed: [], outside: true, dispatch: { type: "lib.Api"
    } }`, line 11 the same as line 10 without `dispatch`. Removed: `{ file: "src/old.ts", name: "write" }`. Expected: the
    set holds the keys (`declarationUseKey("src/old.ts::write", referenceKey(reference))`) of lines 3, 4, 7, 9 and 11
    only. Lines 5 (same anchor), 6 (`unbound`), 8 (a replaceable receiver whose only proof is a syntax declaration: a
    provider may substitute the receiver) and 10 (an outside receiver with a dispatch, R5) stay.
  - `impact-queries.test.ts`, `a removed declaration's cut leaves a reference a member proof binds to another declaration`.
    Fixture like the `callers` member-proof test of that file (`const proof = { owner, receiver, member: { path:
    "src/store.ts", symbol: "write", line: 3 }, reference: { file: "src/owner.ts", line: 7, column: 1, ... name:
    "this.store.write" } }`, `relationReader.extract` returning `memberUses: [proof]` when `options?.memberProofs?.
    completeSource`), plus `changes: { ok: true, value: [change("src/old.ts", { deleted: true, added: [], removedNames:
    ["write"] })] }`, unresolved `this.store.write` at `src/owner.ts:7` and `this.other.write` at `src/owner.ts:8`.
    Before: cut `at: ["src/old.ts::write", "src/owner.ts:7", "src/owner.ts:8"]`. After: `at: ["src/old.ts::write",
    "src/owner.ts:8"]`.
- **Acceptance:** the three tests pass; the existing tests of `removedDeclarationCuts` and of the removed-declaration
  cuts in `impact-queries.test.ts` pass unchanged (they pass no binder, so `notUses` is empty). Gate items:
  1. *Owner:* `CallBindings` decides the binding; `removedNotUses` compares it; the domain only reads a set.
  2. *Contract:* the new parameter is a set of keys; no proof type crosses into the domain.
  3. *No second path:* `removalCandidates` is the one pairing; the binder is the one binding (ADR-0041).
  4. *No chain of special cases:* one comparison over the owner's closed `kind`.
  5. *Fitness:* it cannot be guarded mechanically beyond the existing row "the repository declarations a call's name
     can bind" of `src/composition/edge-targets.single-rule.test.ts`, which already forbids a second by-name binder;
     the rule here is a comparison of two anchors over the owner's answer.
- **Corpus gate expectation:** `--expect impact:- --expect-cuts removed-declaration:-` (an answer may also stay equal
  where no proof exists; if the gate shows `0` difference, report it, do not widen). Ledger rows that must not
  increase: `impact | typescript | unresolved-link | removed-declaration` (27), `impact | java | ... removed-declaration`
  (5). No other family moves.
- **Risk:** Risk: item 6 (a wrong drop is a missed dependent; the RED tests above and the gate difference review are
  the guard).
- **Stop conditions:** `boundCalls` or `EdgeTargets.bindings` is gone or has another signature; the existing
  removed-declaration tests fail after step 2 (the extraction changed the order of places); a binding kind not listed in
  R2 exists; the gate moves a family other than `impact`.

### U2: the owner relation

- **Goal:** a reference whose receiver type is proven unrelated to the removed member's owner is not listed, and a
  homonym of another owner in the same file stops sharing the removed anchor's verdict.
- **Prerequisites:** U1 on `main`.
- **Files to edit:** `src/core/domain/change/seeds.ts` (`RemovedDeclaration.owners`, `selectSeeds`),
  `src/core/domain/change/diff-reader.ts` (`FileChange.removedOwners`), `src/core/ports/declaration-evidence.port.ts`,
  `src/core/adapters/typescript/declaration-evidence.adapter.ts` and its test, `src/core/application/impact/
  impact-queries.ts` (`readChange`, `impactOf`), `src/core/application/impact/removed-uses.ts` and its test,
  `src/core/domain/change/seeds.test.ts`. **Must not touch:** the diff text reading (`declaredIdentifier`).
- **Steps:**
  1. Port: add to `DeclarationEvidenceReader`
     `owners(input: { path: string; base: string | undefined; head: string | undefined; names: readonly string[];
     deleted: boolean }): ReadonlyMap<string, readonly string[]>`; doc: "for a name, the names of the types that
     declared it in `base`, one per removed instance; a name is absent when some removed instance is not a direct member
     of a named class or interface, or the source is not read".
  2. Adapter: implement `owners` over the same `declarations(path, text)` walk. Extend the walk to record, for each
     counted key, the direct owner entry (`owners.at(-1)`), and implement the retained-instance rule of `validate`
     (`(after.get(key) ?? 0) < count`). The direct owner entry has the form `${node.kind}:${name}` (the walk writes
     it for classes, interfaces, functions and modules): accept an entry as a type owner only when its kind prefix is
     `${ts.SyntaxKind.ClassDeclaration}:` or `${ts.SyntaxKind.InterfaceDeclaration}:`. A name with any retained
     instance whose owner entry is not a type owner, or whose source does not parse (`declarations` answers
     `undefined`), is absent from the map. Languages other than TypeScript and JavaScript answer an empty map.
  3. `readChange`: where `validatedChanges` is built from `validated`, also call `deps.declarationEvidence.owners(...)`
     with the same input and set `removedOwners` on the file (an object built from the map entries). `FileChange`'s
     spread in `settleFile` and the other `{ ...file }` constructions keep the field.
  4. `selectSeeds`: `removed.push(...change.removedNames.map((name): RemovedDeclaration => ({ file: change.path,
     name, ...(change.removedOwners?.[name] === undefined ? {} : { owners: change.removedOwners[name] }) })))`.
  5. `removedNotUses`: take `relation` of type `OwnerRelation`
     (`{ unrelated(typeId: GraphNodeId, owner: string, file: string): boolean; ownersOf(target: GraphSymbol): readonly string[] }`)
     built in `impactOf` from `createGraphNavigation`'s `typesAround`, `ownersOf` and `input.reading.unplacedSupertypes`,
     `changedFiles = new Set(changes.map(({ path }) => path))`. Apply R6 and R7 as written.
- **RED tests:**
  - Adapter (`declaration-evidence.adapter.test.ts`), `the owners of a removed member are the named types that declared it`:
    base `export class Store {\n  error = 1;\n  load() {}\n}\nexport class Panel {\n  error = 2;\n}\n`, head
    `export class Store {\n  load() {}\n}\nexport class Panel {\n  error = 2;\n}\n`, names `["error"]`. Expected:
    `new Map([["error", ["Store"]]])`. Same names over a base that declares `error` in an object literal
    (`export const state = { error: 1 };`) and a head without it: `new Map()`.
  - Domain (`seeds.test.ts`): a change with `removedOwners: { error: ["Store"] }` gives `removed: [{ file, name:
    "error", owners: ["Store"] }]`; without the field, `{ file, name: "error" }` (the previous behavior).
  - Application (`removed-uses.test.ts`), `a receiver typed by an unrelated, closed, unchanged type is no use, and any open condition keeps the pair`.
    Fixture graph: `Store` (class, `src/store.ts`) and `Panel` (class, `src/panel.ts`), no heritage edges; removed
    `{ file: "src/store.ts", name: "error", owners: ["Store"] }`; a fake binder answering for the reference at line 5
    `{ kind: "receiver", proof: { link: "local", holds: {...}, type: <Panel> }, candidates: [], attributed: [] }`.
    Expected: the key is in the set. Then, one test case each, the key is absent when: an `extends` edge `Panel` to
    `Store` exists; `unplacedSupertypes` answers one entry; `src/panel.ts` is in `changedFiles`; `owners` is undefined;
    two classes named `Store` are in `src/store.ts`.
  - R7: a binding whose target is `src/store.ts::error` of owner `Panel`, removed owners `["Store"]`: in the set; with
    owners `["Panel"]`: absent.
- **Acceptance:** tests pass; U1 tests pass unchanged; gate items: owner (`removedNotUses` with the hierarchy of the
  graph navigation), contract (`owners` optional, additive; no schema), no second path (hierarchy through
  `typesAround`), no case chain (one relation over closed inputs), fitness: no mechanical guard (a conjunction over the
  owner's answers); the adapter test holds the extraction.
- **Corpus gate expectation:** `--expect impact:- --expect-cuts removed-declaration:-`; rows as U1.
- **Risk:** Risk: item 6.
- **Stop conditions:** the walk in `declaration-evidence.adapter.ts` no longer writes owner entries as described; the
  RED passes before the change; a binding shape outside R2 appears.

### U3: measurement and decision (no code on `main`)

- **Goal:** know what removed-declaration places remain after U1 and U2, and decide U4 by presence, not by a constant.
- **Prerequisites:** U1 and U2 on `main`.
- **Command:** `node --import tsx scripts/corpus-gate.ts --corpus <manifest> --base <the commit before U1> --candidate main
  --expect impact:- --expect-cuts removed-declaration:-` from a worktree of `main`, once, with no other gate or suite
  running. Then read the number:
  `node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); for (const row of r.ledger.candidate.rows) if (row.reason==="removed-declaration") console.log(row.language, row.cuts, JSON.stringify(row.answersWith))' <report.json>`
  (baseline: `typescript 27`, `java 5`).
- **Steps for the implementer:** (1) write both rows into the report of the unit; (2) for each remaining cut, run the
  `impact` query the manifest names with `--json` and list, per remaining place, the shape of its reference line (a
  property read of a response object, a call on a library-typed value, a call on an untyped value, an import, another);
  (3) check the shape of the removed declarations (a class member, an object-literal entry, a top-level declaration)
  from the base source of each.
- **Decision table:**

| Remaining `removed-declaration` cuts, `typescript` and `java` | Decision |
|---|---|
| 0 and 0 | Close the RFC. U4 is not built. Record the result |
| more than 0 in either | Build U4. The gate of U4 declares `--expect-cuts removed-declaration:-`; if it shows no row moving, revert U4 (its stop condition) and record that the base classification adds nothing on this corpus |
| a remaining cut whose removed declarations are object-literal entries or top-level declarations (no `owners`) | U4 is the only route for them; build it |
| a remaining cut whose places are import lines or type references | Report them as true dependents (a removed declaration still imported) and keep them: no unit |

  No numeric threshold decides: the cost of U4 is reported at its gate (`wallMs` base against candidate in the report),
  and the owner decides at integration whether the cold base build is acceptable.
- **Risk:** Risk: none. **Stop conditions:** the gate fails for a reason outside U1 and U2.

### U4: the base revision reading (conditional on U3)

- **Goal:** the cut keeps the head references the base resolved into the removed declaration, drops the ones the base
  resolved to another declaration at a place the change did not touch, and keeps everything else.
- **Prerequisites:** U3 decided to build it.
- **Files to edit:** `src/core/application/impact/impact-queries.ts` (`ofChangeAtRevision`, `ofChangeLive`, `readChange`
  input, `impactOf` input), `src/core/application/impact/removed-uses.ts` (a second function), their tests,
  `src/core/domain/shared/fact.ts` (`CUT_CAUSES` gains `"resolved-at-base"`), `src/core/domain/impact/impact-cuts.ts`
  (`removedDeclarationCuts` takes `resolvedAtBase`). **Must not touch:** the head reading, `indexHead`.
- **Steps:**
  1. `readChange`'s input gains `openBase?: () => Promise<HeadOpening>`. In `ofChangeAtRevision` set
     `openBase: () => changeReader.indexHead(preparedBase.value, readScope.directory, signal)` when
     `mergeBase !== head.value`; in `ofChangeLive` the same with `preparedBase.value`. `impactOf` receives `openBase`
     and `baseSources` (`baseTree.sources`) and `changes` (the `FileChange[]`, for the hunks).
  2. After the U1 and U2 filters, if `removalCandidates(...)` minus `notUses` is empty, do nothing (the base index is
     not opened). Otherwise `const opened = await openBase()`; `"aborted"` returns `ABORTED`; any other non-store value
     keeps today's cut. Close the store in a `finally`.
  3. `baseClassification(candidates, baseStore, changes)` (pure over the store): for each removed declaration `R`, the
     base node is the one declaration in `baseStore.symbolsInFiles([R.file])` with `name === R.name`, a kind of
     `REFERENCED_BY` for the reference's kind, and, when `R.owners` is defined, whose owner (`ownersOf`) has a name in
     `owners`; none or several: classify nothing for `R`.
  4. For each candidate reference `h` of `R` (file `F`, line `L`, column `C`): `baseLine = unchangedBaseLine(F, L,
     changes)`:
     ```
     unchangedBaseLine(F, L, changes):
       change = changes.find((file) => file.path === F)
       if change === undefined: return L                       // file untouched: same text, same line
       if change.deleted || change.binary: return undefined
       offset = 0
       for hunk of change.hunks sorted by head start:
         if hunk.head !== undefined and hunk.head.start <= L <= hunk.head.end: return undefined   // the line changed
         if hunk.head === undefined ? hunk.removals position < L : hunk.head.end < L:
           offset += (hunk.head === undefined ? 0 : hunk.head.end - hunk.head.start + 1) - (hunk.base === undefined ? 0 : hunk.base.end - hunk.base.start + 1)
       return L - offset
     ```
     A removal-only hunk sits after head line `place.after`; it contributes when `after < L`. If `baseLine === undefined`: keep.
  5. With `baseLine`, read the base edges at that place: `edges = baseStore.incomingEdges([R.id], FOLLOWED_EDGE_KINDS)`;
     `dependent` when an edge has `line === baseLine` and `column === C` and its source is in `F`; otherwise `elsewhere`
     when a base `outgoingEdges` of a symbol of `F` has `line === baseLine`, `column === C`, a target whose anchor is not
     `R`'s, and `provenance !== "heuristic"`. Otherwise `unknown`.
  6. `elsewhere` is added to `notUses`. `dependent` places are returned in `resolvedAtBase` (a `ReadonlySet` of
     `declarationUseKey(anchor, referenceKey)`); `removedDeclarationCuts` adds to the cut
     `cause: [placeAt(reference.file, reference.line, "resolved-at-base"), ...]` sorted, for the places in that set.
     `unknown` changes nothing.
- **RED tests (domain, no store):** `removedDeclarationCuts` with `resolvedAtBase` holding one pair: the cut gains
  `cause: ["src/C.java:4 resolved-at-base"]` and keeps its `at`; without it, no `cause` key (previous behavior). Pure
  `unchangedBaseLine` tests: untouched file returns the line; a line inside a hunk returns `undefined`; a line after a
  hunk that added 2 lines and removed 1 returns `L - 1`; a line after a removal-only hunk of 3 lines returns `L + 3`.
  Application test with a fake base store (`fakeCodeGraph`): an edge into the removed node at the mapped place gives
  `dependent`; an edge to another node with `provenance: "tree-sitter"` gives `elsewhere`; the same edge with
  `provenance: "heuristic"` gives `unknown`; no edge gives `unknown`.
- **Acceptance:** tests pass; the base index is opened only when candidates remain (a test with no candidates asserts
  `openBase` is not called); gate: owner (`removedNotUses` family; the base store is read through the same store
  port), contract (one optional `CutCause` member; no schema bump), no second path (the head filters run first and are
  not repeated), no case chain (one classification over three outcomes), fitness: none mechanical (the classification is
  a table over three outcomes, covered by the tests above).
- **Corpus gate expectation:** `--expect impact:± --expect-cuts removed-declaration:-`; report the wall time of the
  queries that opened the base index, cold and warm.
- **Risk:** Risk: item 6 and item 5 (it adds a full index build to some impact queries; the gate reports the cost).
- **Stop conditions:** `indexHead` no longer accepts a prepared commit; the base index of the gate's repositories is
  not opened (`unavailable`) for every query; the cost the gate reports is not acceptable to the owner.

## Not covered

| Case | What the engine answers | Why it stays |
|---|---|---|
| A Java removed declaration's owner | the cut as today, no `owners` | no Java reader of base owners exists; Java has 5 of the 32 baseline cuts and its names are mostly top-level classes and members of removed types, where the base reading (U4) is the proof route |
| A reference through an outside receiver with a dispatch (Java) | kept | needs `mayRunUnder` over a declaration the removal destroyed (R5) |
| A removed declaration whose owner type is gone at head | owner relation not applied | the hierarchy of a type that no longer exists is not read at head; U4 reads it at base |
| A reference through a type alias, a union or an `any` | kept | the binder proves no repository type for it |
| A module augmentation of a library type | an external-proven reference is dropped | the assumption every external proof of the engine makes (ADR-0019) |
| A removed declaration moved to another file | R8: no rule | see R8 |

## Resolved questions (owner, 2026-11-17: "acepto las sugerencias para las decisiones pendientes")

| # | Question | Decision |
|---|---|---|
| 1 | Which proofs does the filter use: the sibling's `settled`, `members` and bound-use keys, or the binder? | The binder (`boundCalls`). Discarded: the sibling's keys, because they are keyed by a walked declaration, `memberTargets` is filled lazily and for methods only, and an `away: []` key means "covered by another cut" (Problem, premises 1 and 2) |
| 2 | Does the domain receive proof types? | No: a set of `declarationUseKey`s. Discarded: passing `ProvenCalls` or `MemberReferenceProofs` into `impact-cuts.ts`, which would put application types in the domain |
| 3 | A homonym that replaced the removed member in the same owner: a use of the updated declaration, or a dependent to review? | A dependent to review: equal anchors keep the pair (R3). Discarded: dropping it, which cannot be distinguished from a use of the removed declaration by anchor. R7 refines it when owners are known. Owner may overturn |
| 4 | An outside-bound reference without dispatch is dropped? | Yes, as every external proof of the engine does (ADR-0019). Discarded: keeping it, which would list `console.error`-like calls forever. The module-augmentation hole is accepted and listed in Not covered. Owner may overturn |
| 5 | Does U2 use the base hierarchy of the removed owner? | No: only the head hierarchy, with the condition that `T`'s hierarchy files are unchanged and both hierarchies are closed. Discarded: reading base heritage in U2, which needs the base index and belongs to U4 |
| 6 | Is `owners` read for Java? | Not now (Not covered). Discarded: a Java owner reader in U2, for 5 of 32 cuts with no measured gain |
| 7 | Moves (a removal plus an addition of the same name in another file) | Stay out (R8). Discarded: a move rule, unsound for an unrelated reuse of the name |
| 8 | Is the base index opened for every impact query? | No: only when candidates remain after the head filters. Discarded: opening it always, which adds a full build to queries that need none |
| 9 | May a base edge to another declaration drop a place? | Only a non-heuristic edge at a place the change did not touch. A heuristic edge is a by-name guess, so it proves nothing; it never drops |
| 10 | How are base-proven dependents labelled? | `Cut.cause` entries `path:line resolved-at-base` (one more `CutCause` member). Discarded: a new reason or an output field, which changes the contract |
| 11 | Is a numeric limit used to decide U4? | No: U3's table decides by presence; the cost is reported at the gate (standing owner preference: no default numeric limits without a measurement) |
