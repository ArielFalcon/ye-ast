# RFC-0039: The Java project answers through queries that record what a derivation reads

- Status: Draft, 2026-11-17; the surface of M0 to M2 is accepted by ADR-0116, M3 and M6 by ADR-0117
- Related: ADR-0031, ADR-0035, ADR-0040, ADR-0077, ADR-0114, ADR-0115 ("Not decided here": the dependency record
  this RFC designs), ADR-0116, ADR-0117, RFC-0037

**In short:** after a one-file edit the Java derivations `relations`, `entrypoints` and `receiver-methods` are derived
again over every file, because the Java project hands other files out as plain objects and no key narrower than the
listing can be shown sound. This RFC replaces those objects with ten primitive questions over a per-file index of
declared names, kept by content. A derivation is then kept by the questions it asked and the answers it got; it is
reused when the same questions give the same answers, and "a file appeared" is an answer that changed. No fact changes.

## 1. Problem

Measured through the stdio MCP, live, `callers` p50 after one edit on a Java backend of 1,340 files (ADR-0115):

| Stage | ms | Key today |
|---|---|---|
| `relations` | 2,268 | the whole listing (ADR-0031) |
| `entrypoints` | 1,751 | the whole listing (ADR-0031) |
| `receiver-methods` | 788 | every Java source and the sites asked (`java-receiver-methods.ts:169-171`) |
| what an unchanged call also pays | about 6,200 | not a key: codegraph reads, the held project, reconciliation |

ADR-0115 names the two missing conditions: every read of another file goes through a call a recorder can see, and "a
file appeared" is a recorded question with its answer.

## 2. Inventory: how the Java readers reach another file today

Counted over `src/core/adapters/spring/*.ts` without tests, by textual occurrence, definitions excluded
(`rg -o` per pattern; the script is not kept).

| # | Way | Sites | Where it lives | Recordable today |
|---|---|---|---|---|
| K1 | Reading the `types` array of a project | 45 in 17 files | `JavaProject.types`, `java-symbols.ts:123` | No: an array |
| K2 | Name resolution: `lookupType` 40, `isPlatformName` 13, `typeIdentity` 5, `importedTypeSources` 4, `bindName` 3, `resolveTypeName` 3, `isGeneratedInterface` 2 | 70 in 22 files | `java-symbols.ts:126-159` | The call is; the `TypeDecl` it returns is not |
| K3 | Hierarchy walks: `hierarchy` 17, `classChain` 17 | 34 in 14 files | `java-symbols.ts:608-638` | Same |
| K4 | Constant evaluation: `evaluate`, `evaluateLong` | 16 in 8 files | `java-symbols.ts:640-670`, `749-758` | Same; it reads initializers of other files |
| K5 | The type around a node: `enclosingType` 35, `thisType` 10 | 45 in 11 files | `java-project.ts:133-149`, each a scan of every type | No |
| K6 | A walk of every syntax tree | 9 walks | see below | No |
| K7 | Properties of a declaration handed out: `methods`, `constructors`, `constants`, `members` 89; a declaration's `node` about 233; a file's `root` 35 | about 357 in 33 files | `TypeDecl`, `MethodDecl`, `Expr`, `JavaFile` | No: properties over syntax trees |
| K8 | A project built by the reader itself | 19 `createJavaProject` call sites in 13 files | 2 build the held project (`java-project.ts:105`, `156`), 8 are the paths of a reader given no hold, 9 are in 8 readers that always build their own | Not applicable |

K1 by what the site wants:

| Reading | Sites | Examples |
|---|---|---|
| Every type of every file | 28 | `java-relations.adapter.ts:45-48`, `spring-routes.adapter.ts:125`, `143`, `223`, `java-receiver-methods.ts:438`, `568-572`, `594`, `636`, `java-dispatch-targets.ts:468`, `callbacks.ts:80`, `111`, `java-call-site-owner.ts:66`, `154`, `java-method-flow.ts:77` |
| The types of one file, by node or place | 11 | `java-project.ts:134`, `148`, `java-receiver-methods.ts:345`, `368`, `673`, `java-ambiguous-names.ts:137`, `308` |
| A name or a package, by scanning | 6 | `java-symbols.ts:481`, `java-receiver-methods.ts:416`, `704`, `1047`, `java-imports.adapter.ts:69`, `java-ambiguous-names.ts:290` |

K6, the walks of every tree:

| Walk | Where | Looks for |
|---|---|---|
| `provesBinding` → `namesAnyDynamicImplementation` | `java-receiver-methods.ts:468`, `1167` | a JDK API that implements an interface at run time |
| `provesBinding` → `rewritesCalls` | `java-receiver-methods.ts:468`, `1193` | a call-rewriting annotation |
| `readUnplacedBelow` | `java-receiver-methods.ts:566-587` | anonymous and local classes and the supertypes they name |
| `isReferenced` | `java-receiver-methods.ts:591-605` | the names method references write |
| `readHierarchy` | `java-dispatch-targets.ts:478-520` | every type declaration, anonymous class, lambda and method reference |
| `globalVeto` | `java-dispatch-targets.ts:571-582` | aspects and dynamic implementations |
| `pathPrefixConfigurations`, `basePathConfigurations` | `path-prefix.ts:23`, `49` | calls and literals that may set a path |
| `JavaMethodFlow` | `java-method-flow.ts:77` | the invocations of every type |

Two facts beside the count:

- `entrypoints` parses every Java source a second time in each read: `extractRoutes` calls `withJavaSources` and
  `createJavaProject` of its own (`spring-routes.adapter.ts:117-120`) and takes no parse hold. So do seven other
  readers (`spring-payload-shapes.adapter.ts:476`, `data-effects.adapter.ts:22`, `java-imports.adapter.ts:42`,
  `java-call-sites.adapter.ts:37`, `java-name-bindings.adapter.ts:73`, `java-declared-types.ts:59`,
  `java-root-bindings.ts:29`).
- The memos shared by the readers of one read (`createResolver`'s `hierarchies`, `signatures`, `unplacedBelow`,
  `referencedNames`, `java-receiver-methods.ts:496-605`; `provenBindings`, `:474`) answer a second reader without
  reading anything, so a recorder placed only on the project would miss the second reader's reads.

## 3. Design

### 3.1 A per-file index of declared names

One per-file derived fact, slot `java-declarations`, kept by the file's content (`DerivedFacts.ofFile`, ADR-0114
decision 1: it takes the file's tree and nothing else) and stored on disk (ADR-0077). Plain data:

| Part | Holds | Replaces |
|---|---|---|
| State | read, declarations only (line of the body error), unparsed (line), unreadable | `unparsed`, `declared`, `unreadable` |
| Header | package and the five kinds of import | `JavaFile`, `java-symbols.ts:14-27` |
| Declarations | per type: names, kind, modifiers, type variables, outer type, place, written supertype clauses, annotation names, member types, and per method and constructor its name, parameter types, modifiers, type variables, place, whether it has a body, takes varargs or overrides; constant names with their declared type | `TypeDecl`, `MethodDecl` without `node` |
| Body summary | the simple names anonymous and local classes write as supertypes; the names method references write; whether it holds a function value; one flag per marker the walks of K6 look for | the nine walks |
| Two digests | of state, header and declarations (unchanged by a body edit); of the whole entry | the keys below |

The snapshot index is the merge of the entries: maps from a qualified name, a package, a simple name, a written
supertype name, a method-reference name, an annotation name, a constant name and a marker to the sorted paths that hold
it. A one-file edit derives one entry and updates the maps; a fresh process reads the entries from the store.

### 3.2 The query surface

Readers hold a `JavaQueries` value instead of a `JavaProject`. It lives where the project lives
(`core/adapters/spring/java-project.ts`, one owner); `createJavaProject` and `JavaFile` stop being exported to readers.

Primitive questions, the only ones a record holds. Each answer is plain, sorted data.

| # | Question | Answer |
|---|---|---|
| P1 | `file(path)` | the content hash, or absent |
| P2 | `declarations(path)` | the declarations digest, or absent |
| P3 | `declaring(qualifiedName)` | the paths that declare it |
| P4 | `package(name)` | whether a source declares it |
| P5 | `named(simpleName)` | the qualified names and paths of the types so named |
| P6 | `naming(kind, name)`, kind one of placed supertype, unplaced supertype, method reference, annotation, constant | the paths that write it |
| P7 | `marked(marker)` | the paths that hold the marker |
| P8 | `unread()` | the paths whose state is not read, and whether a JVM source no extractor reads is listed |
| P9 | `build()` | what the build states (`generatesInterfaces`, a `lombok.config` in the listing, the platform packages the sources claim) |
| P10 | `listing()` | the digest of every Java path and content: today's key, for a reader not yet migrated |

Composite queries, written once over the primitives and never recorded themselves:

| Query | Today | Asks |
|---|---|---|
| `lookupType`, `bindName`, `resolveTypeName`, `typeIdentity`, `importedTypeSources` | K2 | P3 and P4 for each name Java's order tries, the ones that answer nothing included; P2 of each file whose members it reads |
| `hierarchy`, `classChain`, `subtypesOf(type)` | K3, `java-receiver-methods.ts:636` | the lookups of each clause; P6 placed supertype for the types below |
| `typesOf(path)`, `typeAround(node)`, `thisType(node)` | K1 by file, K5 | P2 of that file; a lookup by node instead of a scan |
| `provesBinding()` | K6 | P8, P7 for the two markers, then the lookups that confirm a candidate |
| `unplacedBelow(type)`, `isReferenced(name)` | K6 | P6 unplaced supertype and method reference, then P1 of each path answered |
| `evaluate`, `evaluateLong` | K4 | the lookups of each constant, P1 of the file whose initializer it reads |
| `syntaxOf(declaration or path)` | K7 `node`, `root` | P1 of that file |
| `everyFile()` | K1 every type | P10 |

Two kinds of handle, so a read of another file states how much of it was read:

| Handle | Carries | Handing it out records |
|---|---|---|
| Declared type or method | the plain data of 3.1 | P2 of its file |
| Syntax, from `syntaxOf` | the node | P1 of its file |

A reader not yet moved to the plain handle keeps receiving `TypeDecl` with its `node`; that records P1 of the file. It
is coarser (a body edit in a file reaches every derivation that named a type of it) and sound, so precision is earned
reader by reader with a measurement, never assumed.

### 3.3 A derivation's key is what it read

`DerivedFacts` (ADR-0035) gains one operation; the port names no language:

```ts
/** What `derive` answers from `subject` and from the answers it records; kept until one of them differs. */
ofReads<T>(slot: string, subject: object, answerNow: (question: string) => string, derive: (record: (question: string, answer: string) => void) => Promise<T>): Promise<T>;
```

| Step | Rule |
|---|---|
| Entry | under slot, reader version and `subject` (the file asked about with its content hash, and every input that is not the Java project named in full, as ADR-0115 decision 1 requires): the value and the ordered pairs of question and answer digest |
| Hit | every recorded question, asked of the current snapshot through `answerNow`, gives the recorded answer. Verification is map lookups and string comparisons; it runs no resolution and parses no file |
| Miss | derive with a fresh record, replace the entry |
| Never stored | a derivation a deadline cut (the determinism invariant, `DeadlineCut` at `java-receiver-methods.ts:454`) |
| Shared memo | a memo entry keeps the reads of the computation that filled it; a hit adds them to the record of whoever asked |
| Nested | a derivation that reads another kept derivation records its slot, subject and value digest, so an unchanged part does not derive the whole again |

The three derivations become one kept derivation per file and a merge:

| Derivation | Subject | Global parts become |
|---|---|---|
| `relations` | one source file and the options (`java-relations.adapter.ts:93` already loops by file) | `typesByName` → P5; `typesByFqn` → P3; `repositoryConstantNames` → P6 constant |
| `entrypoints` | one source file; the configuration and contract files a finding reads, named in full | `applicationModules` → P6 annotation; path and base-path evidence → P7; callbacks over anonymous classes → P6 unplaced supertype; it reads the held project, not a parse of its own |
| `receiver-methods` | one file and its sites | `provesBinding`, `unplacedBelow`, `isReferenced`, `subtypesOf` as above |

The stage keys of ADR-0031 stay: after an edit the stage runs, and each of its parts hits or derives.

### 3.4 Why it is sound

A derivation is a deterministic function of its subject and of the answers to the questions it asks, in order. If every
recorded answer is the answer now, then by induction over its execution it asks the same questions, receives the same
answers and returns the same value. This is the verifying trace of build systems (Mokhov, Mitchell, Peyton Jones,
"Build systems à la carte", ICFP 2018), the memo verification of Salsa, and the rule Skyframe states for its functions:
read data only by requesting dependencies. It holds on three conditions, each held by construction:

| Condition | Held by |
|---|---|
| No read outside the surface | no `types` array, no exported `createJavaProject` or `JavaFile`; a fitness test over imports lists the readers still allowed `everyFile()`, a list that only shrinks |
| No state shared between derivations without its reads | the shared-memo rule of 3.3 |
| A question that answers nothing is a question | P3 to P7 answer the empty list and it is recorded, so a file that appears and declares the name changes the answer |

The cases ADR-0114 and ADR-0115 call unsound for a cheaper key:

| Case | Today | With recorded reads |
|---|---|---|
| An anonymous class in another file extends the type | `readUnplacedBelow` walks every tree | P6 unplaced supertype for the type's name is recorded; a file that gains one changes the answer; each answered path adds P1, so an edit to it re-derives |
| A lambda or a method reference may implement a port | `readHierarchy` collects every function value; `isReferenced` every reference | P6 method reference for the name, and the per-file derivation of a file's function values, read by its value digest |
| A base class subscribes inside a method | `natsListenersOf` reads the bodies of the class chain | `classChain` hands the base out, `syntaxOf` records P1 of its file; a body edit there changes the answer |
| An enumeration of all types | 28 sites | a question by name, by annotation or by marker where the site wants one; a derivation per file and a merge where it wants each; `everyFile()` with today's key otherwise |
| A file appears or disappears | the listing key | it changes P3, P4, P5, P6 or P7 only for the names it declares or writes |
| A global veto flips (a call-rewriting annotation anywhere) | every binding unproven | P7 changes for every derivation that asked: all derive again, which is correct and deliberately coarse |

What the designs it follows contribute:

| Source | Taken |
|---|---|
| [rust-analyzer architecture](https://rust-analyzer.github.io/book/contributing/architecture.html): the invariant that typing inside a function body never invalidates global derived data, and `ItemTree`, a per-file summary stable under body edits | the per-file index with a digest a body edit keeps |
| [Salsa, the red-green algorithm](https://salsa-rs.github.io/salsa/reference/algorithm.html): dependencies recorded while a function runs, a memo verified against them, backdating | recorded reads, and the nested rule |
| [Bazel Skyframe](https://bazel.build/reference/skyframe): dependencies requested through the environment, change pruning | reads only through the surface |
| TypeScript's builder (`updateShapeSignature`, `referencedMap` in `builderState.ts`): a file's dependents are checked again only when its declaration signature changes | P2 against P1 |

## 4. Migration, by measured value

Each unit starts with the ADR that amends ADR-0114 decision 1 or ADR-0115 decision 6, passes the corpus gate with
`--expect none`, and reports its stage before and after on the same repository.

| Unit | Change | Measured value | Expected after one edit |
|---|---|---|---|
| M0 | Measure inside the three stages and the held project: parse, project build, derivation | none; it sets the numbers below | |
| M1 | The `java-declarations` slot, the snapshot index and `JavaQueries` over them; the composites answer as today; K5 becomes a lookup. No reader changes its key | none by itself | unchanged |
| M2 | `DerivedFacts.ofReads`; `relations` per file | 2,268 ms | one file derived, 1,339 verified |
| M3 | `entrypoints` per file, on the held project | 1,751 ms, and one parse of every source per read | one file derived |
| M4 | `receiver-methods` per file of sites, with `provesBinding`, `unplacedBelow`, `isReferenced` as queries | 788 ms | the files of the asked sites verified |
| M5 | The held project parses a file when `syntaxOf` asks for it | part of the 6,200 ms an unchanged call pays; M0 says how much | only the files a derivation reads are parsed |
| M6 | The entries of `ofReads` in the disk tier | the same stages in a fresh process | |

`relations` goes first although ADR-0115 names `receiver-methods`: since ADR-0114 it is the largest stage and it has the
fewest global reads (three maps and one set).

Expected one-edit cost, a hypothesis until M0 and each unit measure it: the only comparable measurement is the
TypeScript split of ADR-0115, where a stage that became per file went from 714 ms to 66 ms. If the three Java stages
fall to that order, a one-edit `callers` call on the 1,340-file backend goes from 11.7 s to about 7 s, against 6.2 s
unchanged. M5 then lowers both figures.

## 5. Proof

| Proof | What it shows |
|---|---|
| Corpus gate, `--expect none`, per unit | no fact changes |
| A second gate pass with the store warmed on the parent commit of each corpus revision | a hit after a real change answers the bytes a cold read gives |
| One test per case of 3.4, through the reader's public seam: derive on a snapshot, apply the edit, compare the warm answer with a cold one and assert the tally of hits and misses | an edit that must invalidate does, and an edit elsewhere does not |
| The fitness test over imports | no read outside the surface |
| The pin of `src/composition/stored-derived-facts.test.ts` for `java-declarations` | a reader that changes what it derives changes its version |

## 6. Risks

| Risk | Answer |
|---|---|
| A read that bypasses the surface makes a hit wrong | construction, the fitness test, and the warmed gate pass |
| A shared memo hides reads | the memo rule; one test where two derivations share a memo and the second must miss |
| Verification costs more than it saves | M0 and each unit measure reads per entry; no bound is set without that number |
| A marker question is asked by every derivation, so its flip derives all again | correct; the same holds today for every edit |
| The index grows the store | the per-file slots of the 918-file backend take 16.9 MB today (RFC-0037); M1 reports the added bytes |
| Parsing on demand breaks "each source once per read" | M5 keeps the parse hold as the only owner of trees (ADR-0040) |

## As measured

### M0: where the time of the three stages goes (2026-11-17)

Java backend, 1,340 files of which 1,173 are read sources; a disposable clone; the stdio MCP, live, `callers`; four
rounds of one edit after a warm-up (p50), then the stages isolated in process. The host was loaded by other sessions,
so read the ratios.

| Stage of a one-edit `callers` call | ms, p50 | What it holds |
|---|---|---|
| `relations` | 2,200 | the held project when it is the first reader to need it (about 540 ms, below), then the derivation |
| `entrypoints` | 1,850 | its own parse of every source and its own project (about 500 ms and 90 ms in the first call, where nothing overlaps), then the derivation, about 1,250 ms |
| `receiver-methods` (13 calls) | 780 | derivation only: the trees and the project are held |
| the whole call | 12,400 | |

| The held project of one read | ms |
|---|---|
| Parse of every source (`declarations` reading) | 470-515 |
| `createJavaProject` over the parsed files | 64-107 |
| `relations` derivation over the held project, repeated four times | 2,255-2,432 |

| Counted over a whole call | Figure |
|---|---|
| Sources read through `readSource` | 10,557 (nine readers over 1,173 files) |
| Time in them | 570-620 ms, so the hold's trees are parsed once and the other eight reads reuse them |
| `createJavaProject` builds | 9 per call, 550 ms in all (about 60 ms each) |

What it settles:

- The three stages are derivation, not parse or project build: the parse of every source is about 0.5 s once per read
  and a project build 60-100 ms, against 2.3 s for `relations` alone. A derivation that hits for every file but one
  saves most of the stage; M5 (parse on demand) is worth at most the 0.5 s of one parse of every source and the 0.5 s
  of `entrypoints`' second parse, so it is decided after M3 and not before.
- `relations` over this backend yields 17,636 relations and 4,294 unresolved uses, the bytes M2 must reproduce.
- Open question 7 is answered by these numbers: M5 is not built with M2.

### M1 and M2: the index and `relations` per file (2026-11-17)

Same backend, the stdio MCP, live, `callers`, p50 of five rounds after one edit (a method added to one implementation
file) and of three unchanged rounds, candidate against the tree before it, one machine, measured in turn.

| | Before | After |
|---|---|---|
| `relations` stage, one edit | 2,319 ms | 187 ms |
| `callers`, one edit | 12,263 ms | 9,351 ms |
| `callers`, unchanged | 6,885 ms | 6,301 ms |
| `relations` stage, first call of a process | 2,199 ms | 3,187 ms |
| `callers`, first call of a process | 16,146 ms | 16,114 ms |

In process, over the same 1,210 sources (`relations` alone): cold with no facts 3.1 s; cold with the facts 3.9 s (the
index of every source, then every file derived); unchanged 134 ms; one edit 701 ms, of which about 540 ms is the held
project a miss needs and that the other stages build in the same call anyway. The kept answer is the bytes a cold read
gives in each of the four reads (17,636 relations, 4,294 unresolved uses), and one edit derives one index entry and one
file.

What the memory tier holds for it: 1.8 MB for the 1,210 declaration entries, and 17.1 MB for the entries of the
relations of every file, almost all of it the values (the findings and unresolved uses, as large as the retained stage
output they sum to); the recorded questions are about 49,000 distinct pairs in all (40 per file: `declaring` 23,000,
`naming` of a constant 12,500, `file` 7,700, `package` 3,800), about 3.6 MB.

What it settles:

- The one-edit stage falls by 2.1 s. The call falls by 2.9 s: the rest is spread over `entrypoints` (1.80 s to 1.66 s)
  and `receiver-methods`, within the noise of a host other sessions load.
- The first call of a process pays one more second: the index is derived for every source and the entries are written.
  The entries of `java-declarations` persist on disk (ADR-0077), so a later process reads them instead of deriving; that
  is not measured here. The entries of `ofReads` follow in M6.
- Reads recorded per file are few (40 distinct pairs on average), so verifying them is not the cost: 187 ms for 1,209
  verified entries and one derived.

### M3 and M6: `entrypoints` per file, and the entries of `ofReads` on disk (2026-11-17)

Same backend, the stdio MCP, live, `callers`, p50 of five rounds, host loaded by other sessions (load average 7 to 24), so read
the ratios. Candidates against main 115cbda67, each measured in turn on one machine; the unchanged rows are three rounds
of five taken alternately.

| | Before | M3 | M3 and M6 |
|---|---|---|---|
| `entrypoints` stage, one edit | 1,746 ms | 924 ms | 935 ms |
| `relations` stage, one edit | 191 ms | 201 ms | 198 ms |
| `callers`, one edit | 10,088 ms | 10,046 ms | 9,497 ms |
| `callers`, unchanged | 6,477 / 7,075 / 6,603 ms | 7,040 ms | 7,251 / 7,174 / 6,213 ms |
| First call of a process, warm disk: `relations` | 2,606 ms | | 725 ms |
| First call of a process, warm disk: `entrypoints` | 1,832 ms | | 1,311 ms |
| First call of a process, warm disk: `callers` | 11,985 ms | | 10,281 ms |
| First call of a process, empty cache: `callers` (three pairs) | 15,976 / 15,194 / 15,384 ms | | 16,373 / 16,336 / 16,513 ms |
| First call, empty cache: `relations` and `entrypoints` together | about 5.0 s | | about 5.9 to 6.3 s |

In process, the Spring routes over the same sources, cold read against the kept read (bytes compared with JSON):

| Repository (sources) | Cold read | Kept, first | Kept, nothing changed | Kept, one edit | One edit: derived, verified |
|---|---|---|---|---|---|
| 1,340-file backend (1,278) | 2,042 ms | 2,397 ms | 939 ms | 897 ms | 1, 1,172 |
| 131-file backend | 136 ms | 188 ms | 78 ms | 86 ms | 1, 86 |
| 206-file application | 107 ms | 141 ms | 47 ms | 49 ms | 1, 80 |

On disk the two slots add 2,356 entries and about 23.5 MB to the 2,360 entries and 26 MB the cache held (`du` blocks).

What it settles:

- The one-edit `entrypoints` stage falls by 0.8 s. What is left of its 0.9 s is the held project (a parse of every source
  and a project build, about 0.6 s, paid once per call by whichever stage needs it first) and the callback walk
  (`readHierarchy` 232 ms and `callbacksOf` 46 ms in process), which reads every declaration and is derived at each run
  of the stage. The per-file part verifies 1,172 entries and derives one.
- M5 (parse on demand) saves nothing yet: the callback walk needs every tree, so the held project is built at every run
  of this stage. M5 follows a per-file form of the callback walk, which needs the supertype edges of each declaration as
  a per-file derivation (the `unplaced`, `invokedSupertypes` and `unsettledSupertypes` of `readHierarchy`); that is the
  next unit and comes before M5.
- The disk tier turns the first call of a process with a warm cache from 2.6 s to 0.7 s for `relations` and from 1.8 s
  to 1.3 s for `entrypoints`; the first call with an empty cache pays about 1 s for the 2,356 entries it writes and for
  the recording. An unchanged call is unaffected: its stages are kept by the stage key.
- A configuration, contract or generator edit derives every file: they are in the subject in full. A lookup of a
  configuration property as a recorded question would narrow that and is not built.

### The callback walk per file (2026-11-17)

Same backend, the stdio MCP, live, `callers`, p50 of five rounds (three for the second first call), one machine, host loaded
by other sessions, so read the stage figures and not the wall of a call: the unchanged rows differ by host load alone
(their `entrypoints` and `relations` stages are 0 ms in both). Candidate (ADR-0118) against main a9686b329, measured in turn.

| | Before | After |
|---|---|---|
| `entrypoints` stage, one edit | 914 ms | 619 ms |
| `relations` stage, one edit | 189 ms | 239 ms |
| `receiver-methods` stage, one edit | 656 ms | 797 ms |
| First call of a process, warm disk: `entrypoints` | 1,296 ms | 486 ms |
| First call of a process, warm disk: `relations` | 433 ms | 485 ms |
| First call of a process, empty cache: `entrypoints` | 3,164 ms | 3,570 ms |
| `callers`, unchanged (stages 0 ms in both) | 6,567 / 6,666 ms | 7,226 / 7,222 ms |

The answer is the bytes of the whole-project walk: the Spring routes of four Java repositories (1,210, 136, 109 and 64
sources; 224,908 bytes of findings for the largest) are equal between the tree before and the candidate, cold and kept, and
a kept read after one edit equals a cold read of the edited sources. One edit derives three entries (the file's
declarations, entrypoints and callbacks).

What it settles:

- The one-edit `entrypoints` stage falls by 0.3 s and the first call of a process with a warm disk by 0.8 s, because a
  read that finds no Java change no longer builds the held project for the stage: every file hits and none is parsed.
- What the stage still pays after one edit (0.6 s) is the held project a miss needs (a parse of every source and a project
  build, about 0.5 s in this host's load) and the derivation of the changed file. `receiver-methods` and `relations`
  build the same project in the same call, so it is paid once by whichever stage misses first: M5 is the only unit left
  that lowers it, and it needs the per-file walk of M4 first, because `receiver-methods` still reads every tree.
- The first call with an empty cache pays about 0.4 s more for the third slot it writes.

### M4: what is left of `receiver-methods` (2026-11-17)

`receiver-methods` is kept as one `ofInputs` entry over the whole listing and the asked sites, so any edit derives every
asked site (656 ms for 13 calls). Its per-file form reads the project through these places in
`java-receiver-methods.ts`, each of which becomes a recorded question before a derivation per file of sites is sound:

| Global read | Where | Becomes |
|---|---|---|
| `provesBinding`: every source read, no dynamic implementation, no call-rewriting annotation anywhere | `provesBinding` (`namesAnyDynamicImplementation`, `rewritesCalls` over every file) | P8 and P7 for `dynamic-implementation` and `call-rewriting` (both markers are in the index) |
| `readUnplacedBelow`: the supertypes of every anonymous and local class, and every unsettled supertype name | `readUnplacedBelow` | P6 `unplaced-supertype` for the name of the type and of each type below it, then P1 of each path answered |
| `isReferenced`: a method reference naming the method anywhere | `isReferenced` | P6 `method-reference` for the name |
| The types below a type: every type whose declared hierarchy includes it | `runnableAmong` (`project.types.filter(declaredHierarchy(other)...)`) | P6 `supertype` for the type's simple name, then the hierarchy of each path answered, each recorded |
| A type by qualified name, a package listing, the types of the site's file | `project.types.find(fqn)`, `project.types.some(package)`, `project.types.filter(file)` | P3, P4 and `typesOf(path)` |
| `methodsByPlace` over every type | `methodsByPlace` (shared with the dispatch readers) | a lookup by the file of the site |

The index holds every marker and naming kind these need, so the unit adds no primitive. It is larger than the three
before it: the resolver is about 670 lines, every site of the table changes how it reads, and an answer that differs in a
byte moves `callers`, so it is its own unit with the whole-project answer kept as the differential reference.

## Open questions

| # | Question | Recommendation |
|---|---|---|
| 1 | Does `relations` go before `receiver-methods`, against the order ADR-0115 names? | Yes. It is the largest measured stage and the smallest read set; `receiver-methods` proves the hardest queries once the mechanism is proven |
| 2 | Does a reader not yet on the plain handle record the whole file (P1) when it receives a type? | Yes. It is sound at once and needs no change in about 233 node reads; each reader earns P2 when a measurement shows its hits suffer |
| 3 | How many entries does `ofReads` keep per subject? | One, replaced on a miss. More is decided by a measured hit rate, for example two branches read in turn |
| 4 | Do the `ofReads` entries persist on disk? | Yes, as M6, after the memory tier is measured. They are per-file derivations, not the whole answers ADR-0077 keeps out. Done (ADR-0117) |
| 5 | May a migrated derivation call `everyFile()`? | No. The three measured derivations reach zero; other readers stay on a frozen list |
| 6 | Does the gate gain the pass warmed on the parent commit? | Yes, for units that touch `ofReads`. It is the only proof over real changes |
| 7 | Is M5 built? | Not before `receiver-methods` is per file: the callback walk is per file since ADR-0118, so the entrypoints stage builds no project when nothing changed, but `receiver-methods` still reads every tree ("The callback walk per file" above) |
| 8 | Does the TypeScript program get the same surface? | Not here. `ofReads` names no language and can serve it; the checker hands out objects this RFC does not wrap |
